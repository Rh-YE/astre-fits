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
     * @param scaleType Scale type / 缩放类型
     * @param useZScale Whether to use zscale / 是否使用zscale
     * @param biasValue Bias value / 偏差值
     * @param contrastValue Contrast value / 对比度值
     * @returns Transformed data and statistics / 变换后的数据和统计信息
     */
    public static async applyScaleTransform(
        hduData: HDUData,
        scaleType: string,
        useZScale: boolean = false,
        biasValue: number = 0.5,
        contrastValue: number = 1.0
    ): Promise<HDUData> {
        if (hduData.type !== HDUType.IMAGE) {
            throw new Error('Scale transform can only be applied to image type HDU / 只能对图像类型的HDU应用缩放变换');
        }

        if (!hduData.width || !hduData.height) {
            throw new Error('Invalid image dimensions / 图像尺寸无效');
        }

        // Create transformed data array / 创建变换后的数据数组
        const transformedData = new Float32Array(hduData.data.length);
        
        // Step 1: Calculate initial low/high values / 第一步：计算初始low/high值
        let low: number, high: number;
        
        // 记录当前的处理参数
        console.log(`[FITSDataProcessor] Scale Transform Parameters:
            Scale Type: ${scaleType}
            Use ZScale: ${useZScale}
            Bias: ${biasValue}
            Contrast: ${contrastValue}`);

        if (useZScale) {
            const zscaleResult = await this.calculateZScale(hduData.data, hduData.width, hduData.height);
            low = zscaleResult.z1;
            high = zscaleResult.z2;
            console.log(`[FITSDataProcessor] ZScale Results:
                Z1 (low): ${low}
                Z2 (high): ${high}`);
        } else {
            // 添加空值检查和实时计算逻辑
            if (hduData.stats?.min === undefined || hduData.stats?.max === undefined) {
                console.log('[FITSDataProcessor] Stats not found, calculating...');
                const stats = await this.calculateDataStatistics(hduData.data);
                low = stats.min;
                high = stats.max;
                console.log(`[FITSDataProcessor] Calculated Stats:
                    Min: ${low}
                    Max: ${high}`);
            } else {
                low = hduData.stats.min;
                high = hduData.stats.max;
                console.log(`[FITSDataProcessor] Using cached stats:
                    Min: ${low}
                    Max: ${high}`);
            }
        }

        // 记录归一化范围
        console.log(`[FITSDataProcessor] Normalization range:
            Low: ${low}
            High: ${high}`);

        // Step 2: Apply bias and contrast / 第二步：应用偏差和对比度
        const biasContrastResult = this.applyBiasContrast(low, high, contrastValue, biasValue);
        low = biasContrastResult.low;
        high = biasContrastResult.high;

        // Step 3: Normalize image / 第三步：归一化图像
        await this.normalizeImage(hduData.data, transformedData, low, high);

        // Step 4: Apply non-linear transform / 第四步：应用非线性变换
        const tempData = new Float32Array(transformedData);
        await this.applyNonLinearTransform(tempData, transformedData, scaleType);

        // Step 5: Clip values / 第五步：裁剪值
        this.clipValues(transformedData);

        // 记录最终结果
        console.log(`[FITSDataProcessor] Transform Results:
            Output Min: 0
            Output Max: 1
            Transform Type: ${scaleType}`);

        // 返回完整的HDUData对象
        return {
            type: hduData.type,
            width: hduData.width,
            height: hduData.height,
            depth: hduData.depth,
            data: transformedData,
            columns: hduData.columns,
            stats: {
                min: 0,
                max: 1,
                mean: hduData.stats.mean,
                stdDev: hduData.stats.stdDev
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
        const range = high - low;
        if (range === 0) {
            targetData.fill(0.5);
            return;
        }

        for (let i = 0; i < sourceData.length; i++) {
            targetData[i] = ((sourceData[i] - low) / range) * 1 + 0.5;
        }
    }

    /**
     * Apply non-linear transform / 应用非线性变换
     */
    private static async applyNonLinearTransform(
        sourceData: Float32Array,
        targetData: Float32Array,
        scaleType: string
    ): Promise<void> {
        const a = 1000; // 常数参数

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
        }
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
} 