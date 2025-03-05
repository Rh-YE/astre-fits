import * as vscode from 'vscode';
import { FITS, FITSHDU, FITSHeader } from '../fitsParser';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { LoadingManager } from './LoadingManager';

// HDU Type Enumeration / HDU类型枚举
export enum HDUType {
    IMAGE = 'IMAGE',
    BINTABLE = 'BINTABLE', 
    TABLE = 'TABLE',
    UNKNOWN = 'UNKNOWN'
}

// Table Column Interface / 表格列数据接口
export interface TableColumn {
    name: string;           // Column name / 列名
    format: string;         // TFORM value / TFORM值
    unit?: string;         // Unit (optional) / 单位（可选）
    dataType: string;      // Data type (E, D, J etc.) / 数据类型（E, D, J等）
    repeatCount: number;   // Repeat count / 重复计数
    data: Float32Array | Float64Array | Int8Array | Int16Array | Int32Array; // Column data / 列数据
}

// Table Data Interface / 表格数据接口
export interface TableData {
    columns: Map<string, TableColumn>;  // Column data mapping / 列数据映射
    rowCount: number;                   // Row count / 行数
}

// Column Data Interface / 多列数据接口
export interface ColumnData {
    name: string;
    data: Float32Array | Float64Array | Int8Array | Int16Array | Int32Array;
    format: string;
    unit?: string;
    dataType: string;
    repeatCount: number;
}

// HDU Data Interface / HDU数据接口
export interface HDUData {
    type: HDUType;
    width?: number;
    height?: number;
    depth?: number;  // 添加depth属性用于多维数据
    data: Float32Array;
    columns?: Map<string, ColumnData>;  // 多列数据支持
    tableData?: TableData;
    stats: {
        min: number;
        max: number;
        mean?: number;
        stdDev?: number;
    };
}

// Cache Item Interface / 缓存项接口
interface CacheItem {
    fits: FITS;
    processedData: Map<number, HDUData>;
    tempFiles: Set<string>;
}

// FITS Data Manager Class / FITS数据管理器类
export class FITSDataManager {
    private static instance: FITSDataManager;
    private fitsCache: Map<string, CacheItem> = new Map();
    private loadingManager: LoadingManager;
    private cacheLock: Map<string, Promise<void>> = new Map();
    private tempDir: string;

    private constructor(context: vscode.ExtensionContext) {
        this.tempDir = path.join(context.globalStorageUri.fsPath, 'fits-temp');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        this.loadingManager = LoadingManager.getInstance();
    }

    // Helper method for lock mechanism / 添加锁机制的辅助方法
    private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
        while (this.cacheLock.has(key)) {
            await this.cacheLock.get(key);
        }

        let resolveLock!: () => void;
        const lockPromise = new Promise<void>(resolve => {
            resolveLock = resolve;
        });

        this.cacheLock.set(key, lockPromise);

        try {
            return await operation();
        } finally {
            this.cacheLock.delete(key);
            resolveLock();
        }
    }

    // Get singleton instance / 获取单例实例
    public static getInstance(context: vscode.ExtensionContext): FITSDataManager {
        if (!FITSDataManager.instance) {
            FITSDataManager.instance = new FITSDataManager(context);
        }
        return FITSDataManager.instance;
    }

    // Load FITS file / 加载FITS文件
    public async loadFITS(fileUri: vscode.Uri, fits: FITS): Promise<void> {
        const uriString = fileUri.toString();
        
        return this.loadingManager.startLoading(uriString, this.withLock(uriString, async () => {
            try {
                const cacheItem: CacheItem = {
                    fits: fits,
                    processedData: new Map(),
                    tempFiles: new Set()
                };

                this.fitsCache.set(uriString, cacheItem);
                
                // Pre-process all HDU data / 预处理所有HDU数据
                for (let i = 0; i < fits.hdus.length; i++) {
                    await this.processHDU(fileUri, i);
                }
            } catch (error) {
                console.error(`Failed to load FITS file: ${uriString}`, error);
                await this.clearCache(fileUri);
                throw error;
            }
        }));
    }

    // Get HDU count / 获取HDU数量
    public getHDUCount(fileUri: vscode.Uri): number {
        const cacheItem = this.fitsCache.get(fileUri.toString());
        return cacheItem?.fits.hdus.length ?? 0;
    }

    // Get HDU header / 获取HDU头信息
    public getHDUHeader(fileUri: vscode.Uri, hduIndex: number): FITSHeader | null {
        const cacheItem = this.fitsCache.get(fileUri.toString());
        return cacheItem?.fits.hdus[hduIndex]?.header ?? null;
    }

    // Get HDU data / 获取HDU数据
    public async getHDUData(fileUri: vscode.Uri, hduIndex: number): Promise<HDUData | null> {
        const uriString = fileUri.toString();

        return this.withLock(uriString, async () => {
            const cacheItem = this.fitsCache.get(uriString);
            if (!cacheItem) return null;

            // Check if already processed / 检查是否已处理
            if (cacheItem.processedData.has(hduIndex)) {
                return cacheItem.processedData.get(hduIndex)!;
            }

            // Process HDU data / 处理HDU数据
            return this.processHDU(fileUri, hduIndex);
        });
    }

    // Process HDU data / 处理HDU数据
    private async processHDU(fileUri: vscode.Uri, hduIndex: number): Promise<HDUData | null> {
        const cacheItem = this.fitsCache.get(fileUri.toString());
        if (!cacheItem) return null;

        const hdu = cacheItem.fits.hdus[hduIndex];
        if (!hdu || !hdu.data) return null;

        // Determine HDU type / 确定HDU类型
        const type = this.determineHDUType(hdu);
        
        // Process data based on type / 根据类型处理数据
        let processedData: HDUData;
        
        const hduWithData = { ...hdu, data: hdu.data } as FITSHDU & { data: Float32Array };
        
        if (type === HDUType.IMAGE) {
            processedData = await this.processImageData(hduWithData);
        } else if (type === HDUType.BINTABLE || type === HDUType.TABLE) {
            processedData = await this.processTableData(hduWithData);
        } else {
            processedData = await this.processDefaultData(hduWithData);
        }

        // Cache processed data / 缓存处理后的数据
        cacheItem.processedData.set(hduIndex, processedData);
        return processedData;
    }

    // Determine HDU type / 确定HDU类型
    private determineHDUType(hdu: FITSHDU): HDUType {
        const xtension = hdu.header.getItem('XTENSION')?.value?.trim().toUpperCase();
        if (xtension) {
            if (xtension === 'IMAGE') return HDUType.IMAGE;
            if (xtension === 'BINTABLE') return HDUType.BINTABLE;
            if (xtension === 'TABLE') return HDUType.TABLE;
            return HDUType.UNKNOWN;
        }

        // If no XTENSION, determine by NAXIS / 如果没有XTENSION，根据NAXIS判断
        const naxis = hdu.header.getItem('NAXIS')?.value || 0;
        const naxis1 = hdu.header.getItem('NAXIS1')?.value || 0;
        const naxis2 = hdu.header.getItem('NAXIS2')?.value || 0;

        if (naxis >= 2 && naxis1 > 1 && naxis2 > 1) {
            return HDUType.IMAGE;
        }
        
        return HDUType.UNKNOWN;
    }

    // Process image data / 处理图像数据
    private async processImageData(hdu: FITSHDU & { data: Float32Array }): Promise<HDUData> {
        const width = hdu.header.getItem('NAXIS1')?.value || 0;
        const height = hdu.header.getItem('NAXIS2')?.value || 0;

        // Calculate statistics / 计算统计信息
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

    // Process table data / 处理表格数据
    private async processTableData(hdu: FITSHDU & { data: Float32Array }): Promise<HDUData> {
        const naxis1 = hdu.header.getItem('NAXIS1')?.value || 0;
        const naxis2 = hdu.header.getItem('NAXIS2')?.value || 0;
        const tfields = hdu.header.getItem('TFIELDS')?.value || 0;

        // Get table type / 获取表格类型
        const xtension = hdu.header.getItem('XTENSION')?.value?.trim().toUpperCase();
        const type = xtension === 'BINTABLE' ? HDUType.BINTABLE : HDUType.TABLE;

        // Create column data map / 创建列数据Map
        const columns = new Map<string, ColumnData>();

        // Collect column information / 收集列信息
        for (let i = 1; i <= tfields; i++) {
            const ttype = hdu.header.getItem(`TTYPE${i}`)?.value || `COL${i}`;
            const tform = hdu.header.getItem(`TFORM${i}`)?.value;
            const tunit = hdu.header.getItem(`TUNIT${i}`)?.value;

            if (tform) {
                const match = tform.match(/^(\d*)([A-Z])/);
                if (match) {
                    const repeatCount = match[1] ? parseInt(match[1]) : 1;
                    const dataType = match[2];

                    // Get column data / 获取列数据
                    const columnData = (hdu.data as any).columns?.get(ttype);
                    if (columnData) {
                        columns.set(ttype, columnData);
                    }
                }
            }
        }

        // Calculate statistics using first column / 计算统计信息（使用第一列数据）
        let min = Number.MAX_VALUE;
        let max = Number.MIN_VALUE;
        
        const firstColumn = Array.from(columns.values())[0];
        if (firstColumn) {
            for (const value of firstColumn.data) {
                if (isFinite(value)) {
                    min = Math.min(min, value);
                    max = Math.max(max, value);
                }
            }
        }

        return {
            type,
            data: hdu.data,
            columns,
            stats: { min, max }
        };
    }

    // Process default data / 处理默认数据
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

    // Create temporary file / 创建临时文件
    public async createTempFile(fileUri: vscode.Uri, data: Buffer, prefix: string = 'fits-data'): Promise<string> {
        const uriString = fileUri.toString();

        return this.withLock(uriString, async () => {
            const cacheItem = this.fitsCache.get(uriString);
            if (!cacheItem) throw new Error('No cache found for file');

            const tempFileName = `${prefix}-${crypto.randomBytes(8).toString('hex')}.bin`;
            const tempFilePath = path.join(this.tempDir, tempFileName);
            
            await fs.promises.writeFile(tempFilePath, data);
            cacheItem.tempFiles.add(tempFilePath);
            
            return tempFilePath;
        });
    }

    // Clear file cache / 清理文件缓存
    public async clearCache(fileUri: vscode.Uri): Promise<void> {
        const uriString = fileUri.toString();

        await this.withLock(uriString, async () => {
            const cacheItem = this.fitsCache.get(uriString);
            
            if (cacheItem) {
                // Clean up temporary files / 清理临时文件
                const deletionPromises = Array.from(cacheItem.tempFiles).map(async tempFile => {
                    try {
                        if (fs.existsSync(tempFile)) {
                            await fs.promises.unlink(tempFile);
                        }
                    } catch (error) {
                        console.error(`Failed to clean up temporary file: ${tempFile}`, error);
                    }
                });

                await Promise.all(deletionPromises);
            }

            // Delete cache item / 删除缓存项
            this.fitsCache.delete(uriString);
        });
    }

    // Clear all caches / 清理所有缓存
    public async clearAllCaches(): Promise<void> {
        const clearPromises = Array.from(this.fitsCache.keys()).map(uriString => 
            this.clearCache(vscode.Uri.parse(uriString))
        );
        await Promise.all(clearPromises);
    }
} 