import * as vscode from 'vscode';
import { FITS, FITSHDU, FITSHeader } from '../fitsParser';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// 定义HDU类型枚举
export enum HDUType {
    IMAGE = 'IMAGE',
    BINTABLE = 'BINTABLE',
    TABLE = 'TABLE',
    UNKNOWN = 'UNKNOWN'
}

// 定义HDU数据接口
export interface HDUData {
    type: HDUType;
    width?: number;
    height?: number;
    data: Float32Array;
    stats: {
        min: number;
        max: number;
        mean?: number;
        stdDev?: number;
    };
}

// 定义缓存项接口
interface CacheItem {
    fits: FITS;
    processedData: Map<number, HDUData>;
    tempFiles: Set<string>;
}

// FITS数据管理器类
export class FITSDataManager {
    private static instance: FITSDataManager;
    private fitsCache: Map<string, CacheItem> = new Map();
    private tempDir: string;

    private constructor(context: vscode.ExtensionContext) {
        this.tempDir = path.join(context.globalStorageUri.fsPath, 'fits-temp');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    // 获取单例实例
    public static getInstance(context: vscode.ExtensionContext): FITSDataManager {
        if (!FITSDataManager.instance) {
            FITSDataManager.instance = new FITSDataManager(context);
        }
        return FITSDataManager.instance;
    }

    // 加载FITS文件
    public async loadFITS(fileUri: vscode.Uri, fits: FITS): Promise<void> {
        const uriString = fileUri.toString();
        
        // 创建新的缓存项
        const cacheItem: CacheItem = {
            fits: fits,
            processedData: new Map(),
            tempFiles: new Set()
        };

        // 存入缓存
        this.fitsCache.set(uriString, cacheItem);
        
        // 预处理所有HDU数据
        for (let i = 0; i < fits.hdus.length; i++) {
            await this.processHDU(fileUri, i);
        }
    }

    // 获取HDU数量
    public getHDUCount(fileUri: vscode.Uri): number {
        const cacheItem = this.fitsCache.get(fileUri.toString());
        return cacheItem?.fits.hdus.length ?? 0;
    }

    // 获取HDU头信息
    public getHDUHeader(fileUri: vscode.Uri, hduIndex: number): FITSHeader | null {
        const cacheItem = this.fitsCache.get(fileUri.toString());
        return cacheItem?.fits.hdus[hduIndex]?.header ?? null;
    }

    // 获取HDU数据
    public async getHDUData(fileUri: vscode.Uri, hduIndex: number): Promise<HDUData | null> {
        const cacheItem = this.fitsCache.get(fileUri.toString());
        if (!cacheItem) return null;

        // 检查是否已处理
        if (cacheItem.processedData.has(hduIndex)) {
            return cacheItem.processedData.get(hduIndex)!;
        }

        // 处理HDU数据
        return this.processHDU(fileUri, hduIndex);
    }

    // 处理HDU数据
    private async processHDU(fileUri: vscode.Uri, hduIndex: number): Promise<HDUData | null> {
        const cacheItem = this.fitsCache.get(fileUri.toString());
        if (!cacheItem) return null;

        const hdu = cacheItem.fits.hdus[hduIndex];
        if (!hdu || !hdu.data) return null;

        // 确定HDU类型
        const type = this.determineHDUType(hdu);
        
        // 根据类型处理数据
        let processedData: HDUData;
        
        const hduWithData = { ...hdu, data: hdu.data } as FITSHDU & { data: Float32Array };
        
        if (type === HDUType.IMAGE) {
            processedData = await this.processImageData(hduWithData);
        } else if (type === HDUType.BINTABLE || type === HDUType.TABLE) {
            processedData = await this.processTableData(hduWithData);
        } else {
            processedData = await this.processDefaultData(hduWithData);
        }

        // 缓存处理后的数据
        cacheItem.processedData.set(hduIndex, processedData);
        return processedData;
    }

    // 确定HDU类型
    private determineHDUType(hdu: FITSHDU): HDUType {
        const xtension = hdu.header.getItem('XTENSION')?.value?.trim().toUpperCase();
        if (xtension) {
            if (xtension === 'IMAGE') return HDUType.IMAGE;
            if (xtension === 'BINTABLE') return HDUType.BINTABLE;
            if (xtension === 'TABLE') return HDUType.TABLE;
            return HDUType.UNKNOWN;
        }

        // 如果没有XTENSION，根据NAXIS判断
        const naxis = hdu.header.getItem('NAXIS')?.value || 0;
        const naxis1 = hdu.header.getItem('NAXIS1')?.value || 0;
        const naxis2 = hdu.header.getItem('NAXIS2')?.value || 0;

        if (naxis >= 2 && naxis1 > 1 && naxis2 > 1) {
            return HDUType.IMAGE;
        }
        
        return HDUType.UNKNOWN;
    }

    // 处理图像数据
    private async processImageData(hdu: FITSHDU & { data: Float32Array }): Promise<HDUData> {
        const width = hdu.header.getItem('NAXIS1')?.value || 0;
        const height = hdu.header.getItem('NAXIS2')?.value || 0;

        // 计算统计信息
        let min = Number.MAX_VALUE;
        let max = Number.MIN_VALUE;
        let sum = 0;
        let sumSquares = 0;

        for (let i = 0; i < hdu.data.length; i++) {
            const value = hdu.data[i];
            min = Math.min(min, value);
            max = Math.max(max, value);
            sum += value;
            sumSquares += value * value;
        }

        const mean = sum / hdu.data.length;
        const variance = (sumSquares / hdu.data.length) - (mean * mean);
        const stdDev = Math.sqrt(variance);

        return {
            type: HDUType.IMAGE,
            width,
            height,
            data: hdu.data,
            stats: { min, max, mean, stdDev }
        };
    }

    // 处理表格数据
    private async processTableData(hdu: FITSHDU & { data: Float32Array }): Promise<HDUData> {
        // 获取表格维度
        const naxis1 = hdu.header.getItem('NAXIS1')?.value || 0;
        const naxis2 = hdu.header.getItem('NAXIS2')?.value || 0;

        // 计算统计信息
        let min = Number.MAX_VALUE;
        let max = Number.MIN_VALUE;
        
        for (const value of hdu.data) {
            if (isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }

        return {
            type: hdu.header.getItem('XTENSION')?.value === 'BINTABLE' ? HDUType.BINTABLE : HDUType.TABLE,
            width: naxis1,
            height: naxis2,
            data: hdu.data,
            stats: { min, max }
        };
    }

    // 处理默认数据
    private async processDefaultData(hdu: FITSHDU & { data: Float32Array }): Promise<HDUData> {
        let min = Number.MAX_VALUE;
        let max = Number.MIN_VALUE;
        
        for (const value of hdu.data) {
            if (isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }

        return {
            type: HDUType.UNKNOWN,
            data: hdu.data,
            stats: { min, max }
        };
    }

    // 创建临时文件
    public async createTempFile(fileUri: vscode.Uri, data: Buffer, prefix: string = 'fits-data'): Promise<string> {
        const cacheItem = this.fitsCache.get(fileUri.toString());
        if (!cacheItem) throw new Error('No cache found for file');

        const tempFileName = `${prefix}-${crypto.randomBytes(8).toString('hex')}.bin`;
        const tempFilePath = path.join(this.tempDir, tempFileName);
        
        await fs.promises.writeFile(tempFilePath, data);
        cacheItem.tempFiles.add(tempFilePath);
        
        return tempFilePath;
    }

    // 清理文件缓存
    public clearCache(fileUri: vscode.Uri): void {
        const uriString = fileUri.toString();
        const cacheItem = this.fitsCache.get(uriString);
        
        if (cacheItem) {
            // 清理临时文件
            for (const tempFile of cacheItem.tempFiles) {
                try {
                    if (fs.existsSync(tempFile)) {
                        fs.unlinkSync(tempFile);
                    }
                } catch (error) {
                    console.error(`清理临时文件失败: ${tempFile}`, error);
                }
            }
        }

        // 删除缓存项
        this.fitsCache.delete(uriString);
    }

    // 清理所有缓存
    public clearAllCaches(): void {
        for (const [uriString, _] of this.fitsCache) {
            this.clearCache(vscode.Uri.parse(uriString));
        }
    }
} 