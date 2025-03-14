import * as vscode from 'vscode';
import { FITS, FITSHDU, FITSHeader } from '../fitsParser';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { LoadingManager } from './LoadingManager';
import { Logger } from './Logger';

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
    private tempFiles: Set<string> = new Set(); // Track all temporary files
    private logger: Logger;

    private constructor(context: vscode.ExtensionContext) {
        this.tempDir = path.join(context.globalStorageUri.fsPath, 'fits-temp');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        this.loadingManager = LoadingManager.getInstance();
        this.logger = Logger.getInstance();

        // Add cleanup on extension deactivation
        context.subscriptions.push({
            dispose: () => {
                this.cleanupAllTempFiles();
            }
        });
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
        this.logger.debug(`[FITSDataManager] Starting to load FITS file: ${uriString}`);
        
        return this.loadingManager.startLoading(uriString, this.withLock(uriString, async () => {
            try {
                this.logger.debug(`[FITSDataManager] Creating cache item for ${fits.hdus.length} HDUs`);
                const cacheItem: CacheItem = {
                    fits: fits,
                    processedData: new Map(),
                    tempFiles: new Set()
                };

                this.fitsCache.set(uriString, cacheItem);
                
                // Pre-process all HDU data / 预处理所有HDU数据
                for (let i = 0; i < fits.hdus.length; i++) {
                    this.logger.debug(`[FITSDataManager] Pre-processing HDU ${i}`);
                    await this.processHDU(fileUri, i);
                }
                this.logger.debug(`[FITSDataManager] FITS file loaded successfully`);
            } catch (error) {
                this.logger.error(`[FITSDataManager] Failed to load FITS file: ${error instanceof Error ? error.message : String(error)}`);
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
        this.logger.debug(`[FITSDataManager] Getting HDU data for index ${hduIndex} from ${uriString}`);

        return this.withLock(uriString, async () => {
            const cacheItem = this.fitsCache.get(uriString);
            if (!cacheItem) {
                this.logger.error(`[FITSDataManager] No cache found for file: ${uriString}`);
                return null;
            }

            // Check if already processed / 检查是否已处理
            if (cacheItem.processedData.has(hduIndex)) {
                this.logger.debug(`[FITSDataManager] Found cached HDU data for index ${hduIndex}`);
                return cacheItem.processedData.get(hduIndex)!;
            }

            // Process HDU data / 处理HDU数据
            this.logger.debug(`[FITSDataManager] Processing HDU data for index ${hduIndex}`);
            return this.processHDU(fileUri, hduIndex);
        });
    }

    // Process HDU data / 处理HDU数据
    private async processHDU(fileUri: vscode.Uri, hduIndex: number): Promise<HDUData | null> {
        const uriString = fileUri.toString();
        this.logger.debug(`[FITSDataManager] Processing HDU ${hduIndex} for ${uriString}`);
        
        const cacheItem = this.fitsCache.get(uriString);
        if (!cacheItem) {
            this.logger.error(`[FITSDataManager] No cache found for file when processing HDU`);
            return null;
        }

        const hdu = cacheItem.fits.hdus[hduIndex];
        if (!hdu) {
            this.logger.error(`[FITSDataManager] HDU ${hduIndex} not found in FITS file`);
            return null;
        }
        if (!hdu.data) {
            this.logger.error(`[FITSDataManager] No data found in HDU ${hduIndex}`);
            return null;
        }

        // Determine HDU type / 确定HDU类型
        const type = this.determineHDUType(hdu);
        this.logger.debug(`[FITSDataManager] Determined HDU type: ${type}`);
        
        // Process data based on type / 根据类型处理数据
        let processedData: HDUData;
        
        const hduWithData = { ...hdu, data: hdu.data } as FITSHDU & { data: Float32Array };
        
        try {
            if (type === HDUType.IMAGE) {
                this.logger.debug(`[FITSDataManager] Processing as image data`);
                processedData = await this.processImageData(hduWithData);
            } else if (type === HDUType.BINTABLE || type === HDUType.TABLE) {
                this.logger.debug(`[FITSDataManager] Processing as table data`);
                processedData = await this.processTableData(hduWithData);
            } else {
                this.logger.debug(`[FITSDataManager] Processing as default data`);
                processedData = await this.processDefaultData(hduWithData);
            }

            // Cache processed data / 缓存处理后的数据
            cacheItem.processedData.set(hduIndex, processedData);
            this.logger.debug(`[FITSDataManager] Successfully processed and cached HDU ${hduIndex} data`);
            return processedData;
        } catch (error) {
            this.logger.error(`[FITSDataManager] Error processing HDU ${hduIndex}: ${error instanceof Error ? error.message : String(error)}`);
            if (error instanceof Error && error.stack) {
                this.logger.debug(`[FITSDataManager] Error stack trace: ${error.stack}`);
            }
            return null;
        }
    }

    // Determine HDU type / 确定HDU类型
    private determineHDUType(hdu: FITSHDU): HDUType {
        const xtension = hdu.header.getItem('XTENSION')?.value?.trim().toUpperCase();
        this.logger.debug(`[FITSDataManager] XTENSION value: ${xtension}`);
        
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
        
        this.logger.debug(`[FITSDataManager] NAXIS=${naxis}, NAXIS1=${naxis1}, NAXIS2=${naxis2}`);

        if (naxis >= 2 && naxis1 > 1 && naxis2 > 1) {
            return HDUType.IMAGE;
        }
        
        return HDUType.UNKNOWN;
    }

    // Process image data / 处理图像数据
    private async processImageData(hdu: FITSHDU & { data: Float32Array }): Promise<HDUData> {
        // Get dimensions from header
        const naxis = hdu.header.getItem('NAXIS')?.value || 0;
        const width = hdu.header.getItem('NAXIS1')?.value || 0;
        const height = hdu.header.getItem('NAXIS2')?.value || 0;
        const depth = naxis > 2 ? (hdu.header.getItem('NAXIS3')?.value || 1) : 1;

        this.logger.debug(`[FITSDataManager] Processing image data:
            NAXIS: ${naxis}
            Width (NAXIS1): ${width}
            Height (NAXIS2): ${height}
            Depth (NAXIS3): ${depth}
            Data length: ${hdu.data.length}
        `);

        // Verify data dimensions
        const expectedSize = width * height * depth;
        if (hdu.data.length !== expectedSize) {
            throw new Error(`Data size mismatch: expected ${expectedSize}, got ${hdu.data.length}`);
        }

        // Calculate statistics / 计算统计信息
        let min = Number.MAX_VALUE;
        let max = Number.MIN_VALUE;
        let sum = 0;
        let sumSquares = 0;

        for (let i = 0; i < hdu.data.length; i++) {
            const value = hdu.data[i];
            if (isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
                sum += value;
                sumSquares += value * value;
            }
        }

        const mean = sum / hdu.data.length;
        const variance = (sumSquares / hdu.data.length) - (mean * mean);
        const stdDev = Math.sqrt(variance);

        this.logger.debug(`[FITSDataManager] Image statistics:
            Min: ${min}
            Max: ${max}
            Mean: ${mean}
            StdDev: ${stdDev}
        `);

        // 返回完整的HDU数据，包含所有维度信息
        return {
            type: HDUType.IMAGE,
            width,
            height,
            depth,
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

    // Add method to cleanup all temporary files
    private async cleanupAllTempFiles(): Promise<void> {
        for (const tempFile of this.tempFiles) {
            try {
                if (fs.existsSync(tempFile)) {
                    await fs.promises.unlink(tempFile);
                }
            } catch (error) {
                console.error(`Failed to delete temporary file: ${tempFile}`, error);
            }
        }
        this.tempFiles.clear();
    }

    // Modify createTempFile to track files
    public async createTempFile(fileUri: vscode.Uri, data: Buffer, prefix: string = 'fits-data'): Promise<string> {
        const uriString = fileUri.toString();

        return this.withLock(uriString, async () => {
            const cacheItem = this.fitsCache.get(uriString);
            if (!cacheItem) throw new Error('No cache found for file');

            // Delete previous temp file if it exists for the same prefix
            const previousTempFiles = Array.from(cacheItem.tempFiles)
                .filter(file => path.basename(file).startsWith(prefix));
            
            for (const prevFile of previousTempFiles) {
                try {
                    if (fs.existsSync(prevFile)) {
                        await fs.promises.unlink(prevFile);
                        cacheItem.tempFiles.delete(prevFile);
                        this.tempFiles.delete(prevFile);
                    }
                } catch (error) {
                    console.error(`Failed to delete previous temp file: ${prevFile}`, error);
                }
            }

            const tempFileName = `${prefix}-${crypto.randomBytes(8).toString('hex')}.bin`;
            const tempFilePath = path.join(this.tempDir, tempFileName);
            
            await fs.promises.writeFile(tempFilePath, data);
            cacheItem.tempFiles.add(tempFilePath);
            this.tempFiles.add(tempFilePath);
            
            return tempFilePath;
        });
    }

    // Modify clearCache to properly cleanup temp files
    public async clearCache(fileUri: vscode.Uri): Promise<void> {
        const uriString = fileUri.toString();

        await this.withLock(uriString, async () => {
            const cacheItem = this.fitsCache.get(uriString);
            
            if (cacheItem) {
                // Clean up temporary files
                const deletionPromises = Array.from(cacheItem.tempFiles).map(async tempFile => {
                    try {
                        if (fs.existsSync(tempFile)) {
                            await fs.promises.unlink(tempFile);
                            this.tempFiles.delete(tempFile);
                        }
                    } catch (error) {
                        console.error(`Failed to clean up temporary file: ${tempFile}`, error);
                    }
                });

                await Promise.all(deletionPromises);
                cacheItem.tempFiles.clear();
            }

            // Delete cache item
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