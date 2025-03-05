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
     * Calculate zscale values for image data
     * 计算图像数据的zscale值
     * @param image Image data array / 图像数据数组
     * @param contrast Contrast value (default: 0.25) / 对比度值（默认：0.25）
     * @param numSamples Number of samples (default: 600) / 采样数（默认：600）
     * @param numPerLine Number of samples per line (default: 120) / 每行采样数（默认：120）
     * @returns [z1, z2] Lower and upper limits / 下限和上限
     */
    private static calculateZScale(
        image: Float32Array,
        width: number,
        height: number,
        contrast: number = 0.25,
        numSamples: number = 600,
        numPerLine: number = 120
    ): [number, number] {
        const ZSMAX_REJECT = 0.5;  // Maximum rejection fraction / 最大剔除比例
        const ZSMIN_NPIXELS = 5;   // Minimum number of pixels / 最小像素数
        const ZSMAX_ITERATIONS = 5; // Maximum number of iterations / 最大迭代次数

        // Sampling / 采样
        const strideY = Math.max(2, Math.floor(height / numPerLine));
        const strideX = Math.max(2, Math.floor(width / numPerLine));
        
        // Create samples array / 创建采样数组
        let samples: number[] = [];
        for (let y = 0; y < height; y += strideY) {
            for (let x = 0; x < width; x += strideX) {
                const value = image[y * width + x];
                if (isFinite(value)) {
                    samples.push(value);
                }
            }
        }

        // Random sampling if too many samples / 如果采样太多则随机采样
        if (samples.length > numSamples) {
            const tempSamples: number[] = [];
            for (let i = 0; i < numSamples; i++) {
                const idx = Math.floor(Math.random() * samples.length);
                tempSamples.push(samples[idx]);
            }
            samples = tempSamples;
        }

        if (samples.length === 0) {
            return [0, 1];
        }

        // Sort samples / 排序采样
        samples.sort((a, b) => a - b);
        const npix = samples.length;
        const centerPixel = Math.max(1, Math.floor((npix + 1) / 2));
        
        // Calculate median / 计算中值
        const median = (npix % 2 === 1 || centerPixel >= npix) ? 
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
                return [samples[0], samples[samples.length - 1]];
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

            // Calculate residuals and sigma / 计算残差和标准差
            let sumResiduals = 0;
            for (let i = 0; i < ngoodpix; i++) {
                const x = i / xscale;
                const fitted = x * slope + intercept;
                const residual = samples[i] - fitted;
                sumResiduals += residual * residual;
            }
            const sigma = Math.sqrt(sumResiduals / ngoodpix);

            // Reject outliers / 剔除偏离点
            const newSamples: number[] = [];
            for (let i = 0; i < ngoodpix; i++) {
                const x = i / xscale;
                const fitted = x * slope + intercept;
                const residual = Math.abs(samples[i] - fitted);
                if (residual < sigma * 2.5) {
                    newSamples.push(samples[i]);
                }
            }

            if (newSamples.length === ngoodpix) {
                break;
            }
            
            samples = newSamples;
            ngoodpix = samples.length;
        }

        // Calculate display range / 计算显示范围
        if (contrast > 0) {
            slope = slope / contrast;
        }

        const z1 = Math.max(samples[0], median - (centerPixel - 1) * slope);
        const z2 = Math.min(samples[samples.length - 1], median + (npix - centerPixel) * slope);

        return [z1, z2];
    }

    /**
     * Apply bias and contrast adjustment
     * 应用偏差和对比度调整
     */
    private static applyBiasContrast(
        min: number,
        max: number,
        contrast: number,
        bias: number
    ): [number, number] {
        const center = (min + max) / 2;
        let width = max - min;
        width *= contrast;
        const newCenter = center + bias * width;
        return [
            newCenter - width / 2,
            newCenter + width / 2
        ];
    }

    /**
     * Normalize image data
     * 归一化图像数据
     */
    private static normalizeImage(
        data: Float32Array,
        min: number,
        max: number
    ): void {
        const range = max - min;
        if (range === 0) {
            data.fill(0.5);
            return;
        }
        
        for (let i = 0; i < data.length; i++) {
            data[i] = (data[i] - min) / range;
        }
    }

    /**
     * Apply non-linear transform
     * 应用非线性变换
     */
    private static applyTransform(
        data: Float32Array,
        transformType: string
    ): void {
        const a = 1000; // 变换参数

        switch (transformType) {
            case 'log':
                for (let i = 0; i < data.length; i++) {
                    data[i] = Math.log10(a * data[i] + 1) / Math.log10(a);
                }
                break;
            case 'power':
                for (let i = 0; i < data.length; i++) {
                    data[i] = (Math.pow(a, data[i]) - 1) / a;
                }
                break;
            case 'sqrt':
                for (let i = 0; i < data.length; i++) {
                    data[i] = Math.sqrt(data[i]);
                }
                break;
            case 'squared':
                for (let i = 0; i < data.length; i++) {
                    data[i] = data[i] * data[i];
                }
                break;
            case 'asinh':
                for (let i = 0; i < data.length; i++) {
                    data[i] = Math.asinh(10 * data[i]) / 3;
                }
                break;
            case 'sinh':
                for (let i = 0; i < data.length; i++) {
                    data[i] = Math.sinh(10 * data[i]) / 3;
                }
                break;
            // linear transform is default, no operation needed
        }
    }

    /**
     * Clip image data to range [0, 1]
     * 将图像数据裁剪到[0, 1]范围
     */
    private static clipImage(data: Float32Array): void {
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.max(0, Math.min(1, data[i]));
        }
    }

    /**
     * Apply scale transform to image data
     * 应用缩放变换到图像数据
     */
    public static async applyScaleTransform(
        hduData: HDUData,
        scaleType: string,
        transformType: string = 'linear',
        biasValue: number = 0.5,
        contrastValue: number = 1.0
    ): Promise<{
        data: Float32Array,
        min: number,
        max: number
    }> {
        if (hduData.type !== HDUType.IMAGE) {
            throw new Error('Scale transform can only be applied to image type HDU / 只能对图像类型的HDU应用缩放变换');
        }

        // Create transformed data array / 创建变换后的数据数组
        const transformedData = new Float32Array(hduData.data);
        const width = hduData.width || Math.sqrt(hduData.data.length);
        const height = hduData.height || Math.sqrt(hduData.data.length);

        // Calculate min/max or zscale / 计算最小最大值或zscale
        let low: number, high: number;
        if (scaleType === 'zscale') {
            [low, high] = this.calculateZScale(transformedData, width, height);
        } else {
            low = hduData.stats.min;
            high = hduData.stats.max;
        }

        // Apply bias and contrast / 应用偏差和对比度
        [low, high] = this.applyBiasContrast(low, high, contrastValue, biasValue);

        // Normalize image / 归一化图像
        this.normalizeImage(transformedData, low, high);

        // Apply offset and scaling / 应用偏移和缩放
        for (let i = 0; i < transformedData.length; i++) {
            transformedData[i] = transformedData[i] * 1 + 0.5;
        }

        // Apply non-linear transform / 应用非线性变换
        this.applyTransform(transformedData, transformType);

        // Clip values / 裁剪值
        this.clipImage(transformedData);

        return {
            data: transformedData,
            min: 0,
            max: 1
        };
    }
} 