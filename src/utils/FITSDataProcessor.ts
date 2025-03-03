import { HDUData, HDUType } from '../models/FITSDataManager';
import { Logger } from '../models/Logger';

/**
 * FITS数据处理器类
 * 提供FITS数据的转换和处理功能
 */
export class FITSDataProcessor {
    private static logger = Logger.getInstance();

    /**
     * 应用缩放变换到图像数据
     * @param hduData HDU数据
     * @param scaleType 缩放类型
     * @returns 变换后的数据和统计信息
     */
    public static async applyScaleTransform(
        hduData: HDUData,
        scaleType: string
    ): Promise<{
        data: Float32Array,
        min: number,
        max: number
    }> {
        if (hduData.type !== HDUType.IMAGE) {
            throw new Error('只能对图像类型的HDU应用缩放变换');
        }

        // 创建变换后的数据数组
        const transformedData = new Float32Array(hduData.data.length);
        const min = hduData.stats.min;
        const max = hduData.stats.max;
        
        // 检查图像大小，如果超过阈值，则使用分块处理
        const isLargeImage = hduData.data.length > 4000000; // 约4百万像素的阈值
        this.logger.debug(`图像大小: ${hduData.data.length} 像素, 使用${isLargeImage ? '分块' : '标准'}处理`);

        // 首先进行归一化处理，将所有数据映射到0-1范围
        await this.applyNormalization(hduData.data, transformedData, min, max, isLargeImage);
        
        // 如果是线性变换，直接返回归一化后的数据
        if (scaleType === 'linear') {
            return {
                data: transformedData,
                min: 0,
                max: 1
            };
        }

        // 创建临时数组存储归一化后的数据
        const tempData = new Float32Array(transformedData);

        // 特殊处理需要全局数据的变换
        if (scaleType === 'histogram') {
            await this.applyHistogramEqualization(
                tempData, transformedData, 0, 1, isLargeImage
            );
        } else if (scaleType === 'zscale') {
            await this.applyZScale(
                tempData, transformedData, isLargeImage
            );
        } else {
            // 对于其他变换，使用分块处理
            await this.applyStandardTransform(
                tempData, transformedData, scaleType, 0, 1, isLargeImage
            );
        }

        // 计算变换后的数据范围
        const { newMin, newMax } = await this.calculateDataRange(transformedData);

        return {
            data: transformedData,
            min: newMin,
            max: newMax
        };
    }

    /**
     * 应用归一化处理，将数据映射到0-1范围
     */
    private static async applyNormalization(
        sourceData: Float32Array,
        targetData: Float32Array,
        min: number,
        max: number,
        isLargeImage: boolean
    ): Promise<void> {
        const range = max - min;
        
        // 避免除以零
        if (range === 0) {
            // 如果范围为0，所有值设为0.5
            targetData.fill(0.5);
            return;
        }
        
        const chunkSize = isLargeImage ? 1000000 : sourceData.length;
        
        for (let start = 0; start < sourceData.length; start += chunkSize) {
            const end = Math.min(start + chunkSize, sourceData.length);
            
            for (let i = start; i < end; i++) {
                targetData[i] = (sourceData[i] - min) / range;
            }
            
            // 给UI线程一些时间更新
            if (isLargeImage) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }

    /**
     * 应用直方图均衡化
     */
    private static async applyHistogramEqualization(
        sourceData: Float32Array,
        targetData: Float32Array,
        min: number,
        max: number,
        isLargeImage: boolean
    ): Promise<void> {
        // 直方图均衡化
        const histSize = 256;
        const hist = new Uint32Array(histSize);
        const cdf = new Uint32Array(histSize);
        
        // 计算直方图 - 使用整个数据集
        // 注意：数据已经归一化到0-1范围
        for (let i = 0; i < sourceData.length; i++) {
            const bin = Math.floor(sourceData[i] * (histSize - 1));
            if (bin >= 0 && bin < histSize) {
                hist[bin]++;
            }
        }
        
        // 计算累积分布函数
        cdf[0] = hist[0];
        for (let i = 1; i < histSize; i++) {
            cdf[i] = cdf[i-1] + hist[i];
        }
        
        // 归一化CDF
        const cdfMin = cdf[0];
        const cdfMax = cdf[histSize-1];
        const cdfScale = 1.0 / (cdfMax - cdfMin || 1); // 避免除以零
        
        // 应用直方图均衡化 - 可以分块处理
        const chunkSize = isLargeImage ? 1000000 : sourceData.length;
        for (let start = 0; start < sourceData.length; start += chunkSize) {
            const end = Math.min(start + chunkSize, sourceData.length);
            
            for (let i = start; i < end; i++) {
                const bin = Math.floor(sourceData[i] * (histSize - 1));
                if (bin >= 0 && bin < histSize) {
                    targetData[i] = (cdf[bin] - cdfMin) * cdfScale;
                }
            }
            
            // 给UI线程一些时间更新
            if (isLargeImage) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }

    /**
     * 应用Z-Scale变换
     */
    private static async applyZScale(
        sourceData: Float32Array,
        targetData: Float32Array,
        isLargeImage: boolean
    ): Promise<void> {
        // z-scale 算法 (简化版本)
        const sampleSize = Math.min(10000, sourceData.length);
        const sample = new Float32Array(sampleSize);
        const step = Math.max(1, Math.floor(sourceData.length / sampleSize));
        
        // 采样数据
        for (let i = 0, j = 0; i < sourceData.length && j < sampleSize; i += step, j++) {
            sample[j] = sourceData[i];
        }
        
        // 计算中位数和标准差
        const sortedSample = sample.slice(0, sampleSize).sort((a, b) => a - b);
        const median = sortedSample[Math.floor(sampleSize / 2)];
        
        // 计算标准差 - 使用更高效的方法
        let sumDiff = 0;
        for (let i = 0; i < sampleSize; i++) {
            const diff = sample[i] - median;
            sumDiff += diff * diff;
        }
        const stdDev = Math.sqrt(sumDiff / sampleSize);
        
        // 应用 z-scale 变换 - 注意数据已经归一化到0-1范围
        // 使用相对于归一化范围的缩放因子
        const zLow = Math.max(0, median - 2.5 * stdDev);
        const zHigh = Math.min(1, median + 2.5 * stdDev);
        const zScale = 1.0 / (zHigh - zLow || 0.01); // 避免除以零或极小值
        
        // 分块处理
        const chunkSize = isLargeImage ? 1000000 : sourceData.length;
        for (let start = 0; start < sourceData.length; start += chunkSize) {
            const end = Math.min(start + chunkSize, sourceData.length);
            
            for (let i = start; i < end; i++) {
                targetData[i] = Math.max(0, Math.min(1, (sourceData[i] - zLow) * zScale));
            }
            
            // 给UI线程一些时间更新
            if (isLargeImage) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }

    /**
     * 应用标准变换
     */
    private static async applyStandardTransform(
        sourceData: Float32Array,
        targetData: Float32Array,
        scaleType: string,
        min: number,
        max: number,
        isLargeImage: boolean
    ): Promise<void> {
        const chunkSize = isLargeImage ? 1000000 : sourceData.length;
        
        for (let start = 0; start < sourceData.length; start += chunkSize) {
            const end = Math.min(start + chunkSize, sourceData.length);
            
            this.processDataChunk(sourceData, targetData, start, end, scaleType, min, max);
            
            // 给UI线程一些时间更新
            if (isLargeImage) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }

    /**
     * 处理数据块
     */
    private static processDataChunk(
        sourceData: Float32Array,
        targetData: Float32Array,
        start: number,
        end: number,
        scaleType: string,
        min: number,
        max: number
    ): void {
        const chunkSize = end - start;
        const chunk = sourceData.subarray(start, end);
        const resultChunk = targetData.subarray(start, end);
        
        switch (scaleType) {
            case 'linear':
                // 线性变换 - 直接复制
                resultChunk.set(chunk);
                break;
                
            case 'log':
                // 对数变换 - 使用批量操作
                // 注意：数据已经归一化到0-1范围，所以需要避免log(0)
                for (let i = 0; i < chunkSize; i++) {
                    // 添加一个小的偏移量避免log(0)
                    resultChunk[i] = Math.log(Math.max(chunk[i], 1e-10) + 1) / Math.log(2);
                }
                break;
                
            case 'sqrt':
                // 平方根变换
                for (let i = 0; i < chunkSize; i++) {
                    resultChunk[i] = Math.sqrt(chunk[i]);
                }
                break;
                
            case 'squared':
                // 平方变换 - 可以使用批量乘法
                for (let i = 0; i < chunkSize; i++) {
                    resultChunk[i] = chunk[i] * chunk[i];
                }
                break;
                
            case 'asinh':
                // 反双曲正弦变换
                for (let i = 0; i < chunkSize; i++) {
                    resultChunk[i] = Math.asinh(chunk[i] * 10) / 3; // 缩放以增强效果
                }
                break;
                
            case 'sinh':
                // 双曲正弦变换
                for (let i = 0; i < chunkSize; i++) {
                    resultChunk[i] = Math.sinh(chunk[i] * 3) / 10; // 缩放以增强效果
                }
                break;
                
            case 'power':
                // 幂律变换 (gamma = 2.0)
                for (let i = 0; i < chunkSize; i++) {
                    resultChunk[i] = Math.pow(chunk[i], 2.0);
                }
                break;
                
            default:
                resultChunk.set(chunk);
                break;
        }
    }

    /**
     * 计算数据范围
     */
    private static async calculateDataRange(data: Float32Array): Promise<{ newMin: number, newMax: number }> {
        let newMin = Number.POSITIVE_INFINITY;
        let newMax = Number.NEGATIVE_INFINITY;
        
        // 分块计算最小值和最大值
        const statsChunkSize = 1000000; // 每次处理100万个元素
        for (let start = 0; start < data.length; start += statsChunkSize) {
            const end = Math.min(start + statsChunkSize, data.length);
            
            for (let i = start; i < end; i++) {
                if (isFinite(data[i])) {
                    newMin = Math.min(newMin, data[i]);
                    newMax = Math.max(newMax, data[i]);
                }
            }
        }
        
        return { newMin, newMax };
    }
} 