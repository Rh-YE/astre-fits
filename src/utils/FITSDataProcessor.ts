import { HDUData, HDUType } from '../models/FITSDataManager';
import { Logger } from '../models/Logger';

/**
 * FITS Data Processor Class
 * FITS数据处理器类
 * Provides FITS data conversion and processing functions
 * 提供FITS数据的转换和处理功能
 */
export class FITSDataProcessor {
    private static logger = Logger.getInstance();

    /**
     * Apply scale transform to image data
     * 应用缩放变换到图像数据
     * @param hduData HDU data / HDU数据
     * @param scaleType Scale type (linear, log, sqrt, etc.) / 缩放类型（线性、对数、平方根等）
     * @param useZScale Whether to use zscale / 是否使用zscale
     * @param biasValue Bias value / 偏差值
     * @param contrastValue Contrast value / 对比度值
     * @param channel Current channel to process / 当前要处理的通道
     * @param axesOrder Current axes order / 当前轴顺序
     * @returns Transformed data and statistics / 变换后的数据和统计信息
     */
    public static async applyScaleTransform(
        hduData: HDUData,
        scaleType: string,
        useZScale: boolean = false,
        biasValue: number = 0.5,
        contrastValue: number = 1.0,
        channel: number = 0,
        axesOrder: number[] = [0, 1, 2]
    ): Promise<HDUData> {
        if (hduData.type !== HDUType.IMAGE) {
            throw new Error('Scale transform can only be applied to image type HDU');
        }

        if (!hduData.width || !hduData.height) {
            throw new Error('Invalid image dimensions');
        }

        // 计算切片大小
        const sliceSize = hduData.width * hduData.height;
        const depth = hduData.depth || 1;

        // 验证通道索引
        if (channel < 0 || channel >= depth) {
            throw new Error(`Invalid channel index: ${channel}`);
        }

        this.logger.debug(`[FITSDataProcessor] Starting scale transform:
            Scale Type: ${scaleType}
            Use ZScale: ${useZScale}
            Bias: ${biasValue}
            Contrast: ${contrastValue}
            Channel: ${channel}
            Axes Order: ${axesOrder ? axesOrder.join(',') : '[0,1,2]'}
            Data dimensions: width=${hduData.width}, height=${hduData.height}, depth=${depth}
            Data length: ${hduData.data.length}
        `);

        // 使用轴顺序提取切片数据
        let sliceData: Float32Array;
        let resultWidth: number;
        let resultHeight: number;
        
        if (depth > 1 && axesOrder && axesOrder.length === 3) {
            // 使用轴顺序提取2D切片
            sliceData = this.extract2DSlice(hduData.data, hduData.width, hduData.height, depth, channel, axesOrder);
            
            // 根据轴顺序确定结果维度
            const dims = [depth, hduData.height, hduData.width];
            const rowDimIndex = axesOrder[1];
            const colDimIndex = axesOrder[2];
            
            resultWidth = dims[colDimIndex];
            resultHeight = dims[rowDimIndex];
        } else {
            // 默认方式提取切片（兼容旧代码）
            const sliceOffset = channel * sliceSize;
            sliceData = hduData.data.subarray(sliceOffset, sliceOffset + sliceSize);
            resultWidth = hduData.width;
            resultHeight = hduData.height;
        }

        this.logger.debug(`[FITSDataProcessor] Extracted slice:
            Slice data length: ${sliceData.length}
            Result width: ${resultWidth}
            Result height: ${resultHeight}
            Expected size: ${resultWidth * resultHeight}
        `);

        // 创建变换后的数据数组
        const transformedData = new Float32Array(sliceData.length);
        
        // 计算数据范围
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        
        for (let i = 0; i < sliceData.length; i++) {
            const value = sliceData[i];
            if (isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }
        
        // 如果使用zscale，计算zscale范围
        if (useZScale) {
            const zscaleResult = await this.calculateZScale(sliceData, resultWidth, resultHeight);
            min = zscaleResult.z1;
            max = zscaleResult.z2;
        }
        
        // 应用偏差和对比度
        const { low, high } = this.applyBiasContrast(min, max, contrastValue, biasValue);
        
        // 归一化数据
        await this.normalizeImage(sliceData, transformedData, low, high);
        
        // 应用非线性变换
        if (scaleType !== 'linear') {
            await this.applyNonLinearTransform(transformedData, transformedData, scaleType);
        }
        
        // 裁剪值到[0,1]范围
        this.clipValues(transformedData);
        
        // 计算变换后的统计信息
        const stats = await this.calculateDataStatistics(transformedData);
        
        this.logger.debug(`[FITSDataProcessor] Transform result:
            Transformed data length: ${transformedData.length}
            Min: ${stats.min}
            Max: ${stats.max}
        `);
        
        // 返回变换后的数据
        return {
            type: HDUType.IMAGE,
            width: resultWidth,
            height: resultHeight,
            depth: depth,
            data: transformedData,
            stats: {
                min: stats.min,
                max: stats.max
            }
        };
    }

    /**
     * Calculate ZScale values / 计算ZScale值
     */
    private static async calculateZScale(
        data: Float32Array,
        width: number,
        height: number,
        contrast: number = 0.25,
        numSamples: number = 600,
        numPerLine: number = 120
    ): Promise<{ z1: number, z2: number }> {
        // Constants / 常量
        const ZSMAX_REJECT = 0.5;
        const ZSMIN_NPIXELS = 5;
        const ZSMAX_ITERATIONS = 5;

        // Sampling / 采样
        const strideY = Math.max(2, Math.floor(height / numPerLine));
        const strideX = Math.max(2, Math.floor(width / numPerLine));
        
        // Create samples array / 创建采样数组
        const samples: number[] = [];
        for (let y = 0; y < height; y += strideY) {
            for (let x = 0; x < width; x += strideX) {
                const value = data[y * width + x];
                if (isFinite(value)) {
                    samples.push(value);
                }
            }
        }

        if (samples.length === 0) {
            return { z1: data[0], z2: data[0] };
        }

        // Sort samples / 排序采样
        samples.sort((a, b) => a - b);
        
        // Calculate median / 计算中值
        const npix = samples.length;
        const centerPixel = Math.max(1, Math.floor((npix + 1) / 2));
        const median = npix % 2 === 1 || centerPixel >= npix ?
            samples[centerPixel - 1] :
            (samples[centerPixel - 1] + samples[centerPixel]) / 2.0;

        // Fit line / 拟合直线
        const minPixels = Math.max(ZSMIN_NPIXELS, Math.floor(npix * ZSMAX_REJECT));
        const xscale = npix - 1;
        let ngoodpix = npix;
        let slope = 0;
        let intercept = median;

        // Iterative fitting / 迭代拟合
        for (let niter = 0; niter < ZSMAX_ITERATIONS; niter++) {
            if (ngoodpix < minPixels) {
                return { z1: samples[0], z2: samples[samples.length - 1] };
            }

            // Least squares fit / 最小二乘拟合
            let sumx = 0, sumy = 0, sumxy = 0, sumxx = 0;
            for (let i = 0; i < ngoodpix; i++) {
                const x = i / xscale;
                const y = samples[i];
                sumx += x;
                sumy += y;
                sumxy += x * y;
                sumxx += x * x;
            }

            const denominator = ngoodpix * sumxx - sumx * sumx;
            if (denominator !== 0) {
                slope = (ngoodpix * sumxy - sumx * sumy) / denominator;
                intercept = (sumy * sumxx - sumx * sumxy) / denominator;
            }

            // Calculate residuals / 计算残差
            let sigma = 0;
            const residuals: number[] = [];
            for (let i = 0; i < ngoodpix; i++) {
                const x = i / xscale;
                const fitted = x * slope + intercept;
                const residual = samples[i] - fitted;
                residuals.push(residual);
                sigma += residual * residual;
            }
            sigma = Math.sqrt(sigma / ngoodpix);

            // Reject outliers / 剔除离群点
            const newSamples: number[] = [];
            for (let i = 0; i < ngoodpix; i++) {
                if (Math.abs(residuals[i]) < sigma * 2.5) {
                    newSamples.push(samples[i]);
                }
            }

            if (newSamples.length === ngoodpix) {
                break;
            }

            samples.length = 0;
            samples.push(...newSamples);
            ngoodpix = newSamples.length;
        }

        // Calculate display range / 计算显示范围
        if (contrast > 0) {
            slope = slope / contrast;
        }

        const z1 = Math.max(samples[0], median - (centerPixel - 1) * slope);
        const z2 = Math.min(samples[samples.length - 1], median + (npix - centerPixel) * slope);

        return { z1, z2 };
    }

    /**
     * Apply bias and contrast / 应用偏差和对比度
     */
    private static applyBiasContrast(
        min: number,
        max: number,
        contrast: number,
        bias: number
    ): { low: number, high: number } {
        const center = (min + max) / 2;
        let width = max - min;
        width *= contrast;
        const biasedCenter = center + bias * width;
        return {
            low: biasedCenter - width / 2,
            high: biasedCenter + width / 2
        };
    }

    /**
     * Normalize image / 归一化图像
     */
    private static async normalizeImage(
        sourceData: Float32Array,
        targetData: Float32Array,
        low: number,
        high: number
    ): Promise<void> {
        // console.log(`[FITSDataProcessor] Starting image normalization:
        //     Source data length: ${sourceData.length}
        //     Target data length: ${targetData.length}
        //     Value range: [${low}, ${high}]
        //     First 5 source values: ${sourceData.slice(0, 5).join(', ')}
        // `);

        const range = high - low;
        if (range === 0) {
            console.log('[FITSDataProcessor] Zero range detected, filling with 0.5');
            targetData.fill(0.5);
            return;
        }

        // Track data transformation for first few pixels
        const transformationSamples = [];
        
        for (let i = 0; i < sourceData.length; i++) {
            targetData[i] = ((sourceData[i] - low) / range) * 1 + 0.5;
            
            // Track first 5 transformations
            if (i < 5) {
                transformationSamples.push({
                    index: i,
                    sourceValue: sourceData[i],
                    normalizedValue: targetData[i]
                });
            }
        }

        // console.log(`[FITSDataProcessor] Normalization samples:`, transformationSamples);
        // console.log(`[FITSDataProcessor] Normalization result:
        //     First 5 normalized values: ${targetData.slice(0, 5).join(', ')}
        //     Last 5 normalized values: ${targetData.slice(-5).join(', ')}
        // `);
    }

    /**
     * Apply non-linear transform / 应用非线性变换
     */
    private static async applyNonLinearTransform(
        sourceData: Float32Array,
        targetData: Float32Array,
        scaleType: string
    ): Promise<void> {
        // console.log(`[FITSDataProcessor] Starting non-linear transform:
        //     Transform type: ${scaleType}
        //     Source data length: ${sourceData.length}
        //     Target data length: ${targetData.length}
        //     First 5 source values: ${sourceData.slice(0, 5).join(', ')}
        // `);

        const a = 1000; // 常数参数
        const transformationSamples = [];

        for (let i = 0; i < sourceData.length; i++) {
            const x = sourceData[i];
            let result: number;

            switch (scaleType) {
                case 'linear':
                    result = x;
                    break;
                case 'log':
                    result = Math.log10(a * x + 1) / Math.log10(a);
                    break;
                case 'power':
                    result = (Math.pow(a, x) - 1) / a;
                    break;
                case 'sqrt':
                    result = Math.sqrt(x);
                    break;
                case 'square':
                    result = x * x;
                    break;
                case 'asinh':
                    result = Math.asinh(10 * x) / 3;
                    break;
                case 'sinh':
                    result = Math.sinh(10 * x) / 3;
                    break;
                default:
                    result = x;
            }

            targetData[i] = result;

            // Track first 5 transformations
            if (i < 5) {
                transformationSamples.push({
                    index: i,
                    inputValue: x,
                    outputValue: result,
                    transformType: scaleType
                });
            }
        }

        // console.log(`[FITSDataProcessor] Transform samples:`, transformationSamples);
        // console.log(`[FITSDataProcessor] Transform result:
        //     First 5 transformed values: ${targetData.slice(0, 5).join(', ')}
        //     Last 5 transformed values: ${targetData.slice(-5).join(', ')}
        // `);
    }

    /**
     * Clip values / 裁剪值
     */
    private static clipValues(data: Float32Array): void {
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.max(0, Math.min(1, data[i]));
        }
    }

    /**
     * Calculate data statistics / 计算数据统计信息
     * @param data Input data array / 输入数据数组
     * @returns Statistics object / 统计信息对象
     */
    private static async calculateDataStatistics(data: Float32Array): Promise<{ min: number, max: number }> {
        console.log('[FITSDataProcessor] Starting statistics calculation...');
        const startTime = performance.now();

        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < data.length; i++) {
            const value = data[i];
            if (isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }

        const endTime = performance.now();
        console.log(`[FITSDataProcessor] Statistics calculation completed in ${(endTime - startTime).toFixed(2)}ms`);

        return { min, max };
    }

    /**
     * Extract 2D slice from 3D data based on axes order
     * 根据轴顺序从3D数据中提取2D切片
     * @param data3D 3D data array / 3D数据数组
     * @param width Width of the data / 数据宽度
     * @param height Height of the data / 数据高度
     * @param depth Depth of the data / 数据深度
     * @param channel Channel index / 通道索引
     * @param axesOrder Axes order [channelDim, rowDim, colDim] / 轴顺序 [通道维度, 行维度, 列维度]
     * @returns 2D slice data / 2D切片数据
     */
    private static extract2DSlice(
        data3D: Float32Array,
        width: number,
        height: number,
        depth: number,
        channel: number,
        axesOrder: number[]
    ): Float32Array {
        this.logger.debug(`[FITSDataProcessor] Starting 2D slice extraction:
            Input dimensions: depth=${depth}, height=${height}, width=${width}
            Channel: ${channel}
            Axes Order: [${axesOrder.join(', ')}]
            Original data length: ${data3D.length}
            First 5 values of original data: ${data3D.slice(0, 5)}
        `);
        
        const channelDimIndex = axesOrder[0];  // 通道维度索引
        const rowDimIndex = axesOrder[1];      // 行维度索引
        const colDimIndex = axesOrder[2];      // 列维度索引
        
        // Get dimensions sizes / 获取各维度大小
        const dims = [
            depth || 1,
            height || 1,
            width || 1
        ];
        
        this.logger.debug(`[FITSDataProcessor] Dimensions:
            Depth: ${depth}
            Height: ${height}
            Width: ${width}
        `);
        
        this.logger.debug(`[FITSDataProcessor] Dimension mapping:
            Channel dimension (${channelDimIndex}): ${dims[channelDimIndex]}
            Row dimension (${rowDimIndex}): ${dims[rowDimIndex]}
            Column dimension (${colDimIndex}): ${dims[colDimIndex]}
        `);
        
        // Calculate result 2D slice dimensions / 计算结果2D切片的尺寸
        const resultWidth = dims[colDimIndex];
        const resultHeight = dims[rowDimIndex];
        
        this.logger.debug(`[FITSDataProcessor] Output dimensions:
            Result width: ${resultWidth}
            Result height: ${resultHeight}
            Expected output size: ${resultWidth * resultHeight}
        `);
        
        // Create result data / 创建结果数据
        const result = new Float32Array(resultWidth * resultHeight);
        
        // Calculate strides for each dimension / 计算每个维度的步长
        // 注意：这里使用的是原始数据的布局，而不是轴顺序重新排列后的布局
        const strides = [
            height * width,  // stride for depth (z)
            width,           // stride for height (y)
            1                // stride for width (x)
        ];
        
        this.logger.debug(`[FITSDataProcessor] Original strides: [${strides.join(', ')}]`);
        
        // Extract 2D slice / 提取2D切片
        for (let y = 0; y < resultHeight; y++) {
            for (let x = 0; x < resultWidth; x++) {
                // 根据轴顺序计算原始数据中的索引
                // 首先确定在每个维度上的坐标
                const coords = [0, 0, 0]; // [z, y, x]
                coords[channelDimIndex] = channel;
                coords[rowDimIndex] = y;
                coords[colDimIndex] = x;
                
                // 使用坐标和步长计算原始数据中的索引
                const sourceIndex = 
                    coords[0] * strides[0] + 
                    coords[1] * strides[1] + 
                    coords[2] * strides[2];
                
                // Calculate destination index / 计算目标数据索引
                const destIndex = y * resultWidth + x;
                
                // Copy data / 复制数据
                if (sourceIndex < data3D.length) {
                    result[destIndex] = data3D[sourceIndex];
                } else {
                    this.logger.warn(`[FITSDataProcessor] Source index out of bounds: ${sourceIndex} >= ${data3D.length}`);
                    result[destIndex] = 0; // 使用默认值
                }
            }
        }
        
        // 计算结果数据的范围
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        
        for (let i = 0; i < result.length; i++) {
            const value = result[i];
            if (isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }
        
        this.logger.debug(`[FITSDataProcessor] Slice extraction result:
            Output dimensions: ${resultWidth}x${resultHeight}
            Output data length: ${result.length}
            First 5 values: ${result.slice(0, 5)}
            Last 5 values: ${result.slice(-5)}
            Value range: [${min}, ${max}]
        `);
        
        return result;
    }
} 