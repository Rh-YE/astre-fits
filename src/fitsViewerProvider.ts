import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FITSParser, FITS } from './fitsParser';
import * as crypto from 'crypto';
import { FITSDataManager, HDUType, ColumnData } from './models/FITSDataManager';
import { LoadingManager } from './models/LoadingManager';
import { Logger, LogLevel } from './models/Logger';
import { WebviewMessageHandler, IWebviewMessageHandler } from './webview/WebviewMessageHandler';
import { WebviewService } from './webview/WebviewService';
import { FITSDataProcessor } from './utils/FITSDataProcessor';

// 定义一个表格字段描述类
class TableField {
    constructor(
        public readonly index: number,        // 字段索引
        public readonly repeatCount: number,  // 重复计数
        public readonly dataType: string,     // 数据类型
        public readonly byteSize: number      // 字节大小
    ) {}

    // 获取字段总字节数
    getTotalBytes(): number {
        return this.repeatCount * this.byteSize;
    }
}

// 定义一个FITS表格解析器类
class FITSTableParser {
    // 数据类型字节映射表
    private static readonly TYPE_BYTE_SIZES = new Map<string, number>([
        ['L', 1],  // Logical
        ['X', 1],  // Bit
        ['B', 1],  // Unsigned byte
        ['I', 2],  // 16-bit integer
        ['J', 4],  // 32-bit integer
        ['K', 8],  // 64-bit integer
        ['A', 1],  // Character
        ['E', 4],  // Single-precision floating point
        ['D', 8],  // Double-precision floating point
        ['C', 8],  // Single-precision complex
        ['M', 16], // Double-precision complex
        ['P', 8],  // Array Descriptor (32-bit)
        ['Q', 16], // Array Descriptor (64-bit)
    ]);

    // 解析TFORM值
    static parseFormat(tform: string): { repeatCount: number, dataType: string } {
        const match = tform.match(/^(\d*)([A-Z])/);
        if (!match) {
            throw new Error(`无效的TFORM格式: ${tform}`);
        }
        return {
            repeatCount: match[1] ? parseInt(match[1]) : 1,
            dataType: match[2]
        };
    }

    // 获取数据类型的字节大小
    static getTypeByteSize(dataType: string): number {
        const size = this.TYPE_BYTE_SIZES.get(dataType);
        if (size === undefined) {
            throw new Error(`未知的数据类型: ${dataType}`);
        }
        return size;
    }
}

/**
 * FITS文件查看器提供程序
 * 实现VSCode自定义编辑器接口，提供FITS文件查看功能
 */
export class FitsViewerProvider implements vscode.CustomReadonlyEditorProvider, IWebviewMessageHandler {
    
    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new FitsViewerProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            FitsViewerProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        );
        return providerRegistration;
    }

    private static readonly viewType = 'astre-fits.fitsViewer';
    private dataManager: FITSDataManager;
    private loadingManager: LoadingManager;
    private logger: Logger;
    private webviewService: WebviewService;
    private currentFileUri: vscode.Uri | undefined;
    private currentHDUIndex = new Map<string, number>();

    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        this.logger = Logger.getInstance();
        this.logger.setLogLevel(LogLevel.INFO);
        this.logger.info('FitsViewerProvider 已创建');
        
        this.dataManager = FITSDataManager.getInstance(context);
        this.loadingManager = LoadingManager.getInstance();
        this.webviewService = new WebviewService(context);
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        this.logger.info(`正在打开文件: ${uri.fsPath}`);
        try {
            // 验证文件是否存在
            await vscode.workspace.fs.stat(uri);
            this.logger.debug('文件存在，继续处理');
            return { uri, dispose: () => { } };
        } catch (error) {
            this.logger.error(`打开文件失败: ${error}`);
            throw error;
        }
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        this.logger.info('正在解析自定义编辑器');
        
        // 配置webview
        this.webviewService.configureWebview(webviewPanel.webview);
        
        // 设置HTML内容
        webviewPanel.webview.html = this.webviewService.getHtmlForWebview(webviewPanel.webview);
        this.logger.debug('已设置webview HTML');
        
        // 创建消息处理器
        const messageHandler = new WebviewMessageHandler(this);
        
        // 处理webview消息
        webviewPanel.webview.onDidReceiveMessage(message => {
            messageHandler.handleMessage(message, document, webviewPanel);
        });
        
        // 当编辑器关闭时清除缓存
        webviewPanel.onDidDispose(() => {
            if (document.uri) {
                this.dataManager.clearCache(document.uri);
                this.currentFileUri = undefined;
                this.logger.info(`已清除文件缓存: ${document.uri.fsPath}`);
            }
        });
    }

    /**
     * 处理webview准备就绪消息
     */
    async handleWebviewReady(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        this.logger.info('Webview已准备好，开始更新数据');
        await this.updateWebview(uri, webviewPanel);
    }

    /**
     * 处理获取像素值消息
     */
    async handleGetPixelValue(uri: vscode.Uri, x: number, y: number, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            // 获取当前HDU索引
            const uriString = uri.toString();
            const currentHduIndex = this.currentHDUIndex.get(uriString) || 0;
            
            const hduData = await this.dataManager.getHDUData(uri, currentHduIndex);
            if (!hduData || hduData.type !== HDUType.IMAGE) {
                throw new Error('无法获取图像数据');
            }
            
            // 检查坐标是否在图像范围内
            if (!hduData.width || !hduData.height || x < 0 || x >= hduData.width || y < 0 || y >= hduData.height) {
                throw new Error('坐标超出图像范围');
            }
            
            // 计算WCS坐标（如果有）
            let wcs1 = '-';
            let wcs2 = '-';
            const header = this.dataManager.getHDUHeader(uri, currentHduIndex);
            if (header) {
                const crpix1 = header.getItem('CRPIX1')?.value;
                const crpix2 = header.getItem('CRPIX2')?.value;
                const crval1 = header.getItem('CRVAL1')?.value;
                const crval2 = header.getItem('CRVAL2')?.value;
                const cdelt1 = header.getItem('CDELT1')?.value;
                const cdelt2 = header.getItem('CDELT2')?.value;
                
                if (crpix1 !== undefined && crpix2 !== undefined &&
                    crval1 !== undefined && crval2 !== undefined &&
                    cdelt1 !== undefined && cdelt2 !== undefined) {
                    const ra = crval1 + ((x + 1 - crpix1) * cdelt1);
                    const dec = crval2 + ((y + 1 - crpix2) * cdelt2);
                    wcs1 = `RA: ${ra.toFixed(6)}°`;
                    wcs2 = `Dec: ${dec.toFixed(6)}°`;
                }
            }
            
            // 发送WCS坐标信息到webview
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setWCSValue',
                wcs1: wcs1,
                wcs2: wcs2
            });
            
        } catch (error) {
            this.logger.error('获取WCS坐标时出错:', error);
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setWCSValue',
                wcs1: '-',
                wcs2: '-'
            });
        }
    }

    /**
     * 处理设置缩放类型消息
     */
    async handleSetScaleType(uri: vscode.Uri, scaleType: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            // 获取当前HDU索引
            const uriString = uri.toString();
            const currentHduIndex = this.currentHDUIndex.get(uriString) || 0;
            
            const hduData = await this.dataManager.getHDUData(uri, currentHduIndex);
            if (!hduData || hduData.type !== HDUType.IMAGE) {
                throw new Error('无法获取图像数据');
            }
            
            // 应用缩放变换
            const transformResult = await FITSDataProcessor.applyScaleTransform(
                hduData,
                scaleType
            );
            
            // 创建临时文件
            const metadataBuffer = Buffer.from(JSON.stringify({
                width: hduData.width,
                height: hduData.height,
                min: transformResult.min,
                max: transformResult.max,
                scaleType: scaleType
            }));
            
            const headerLengthBuffer = Buffer.alloc(4);
            headerLengthBuffer.writeUInt32LE(metadataBuffer.length, 0);
            
            const dataBuffer = Buffer.from(transformResult.data.buffer);
            
            const combinedBuffer = Buffer.concat([
                headerLengthBuffer,
                metadataBuffer,
                dataBuffer
            ]);
            
            const tempFilePath = await this.dataManager.createTempFile(uri, combinedBuffer);
            
            // 发送文件URI到webview
            this.webviewService.sendImageDataFileUri(webviewPanel.webview, vscode.Uri.file(tempFilePath));
            
        } catch (error) {
            this.logger.error('设置缩放类型时出错:', error);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 
                `无法应用缩放: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 处理获取头信息消息
     */
    async handleGetHeaderInfo(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        // 获取当前HDU索引
        const uriString = uri.toString();
        const currentHduIndex = this.currentHDUIndex.get(uriString) || 0;
        
        await this.sendHeaderInfo(uri, webviewPanel, currentHduIndex);
    }

    /**
     * 处理切换HDU消息
     */
    async handleSwitchHDU(uri: vscode.Uri, hduIndex: number, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const uriString = uri.toString();

        if (this.loadingManager.isLoading(uriString)) {
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 'HDU切换中，请稍候...');
            return;
        }

        try {
            // 更新当前HDU索引
            this.currentHDUIndex.set(uriString, hduIndex);
            this.logger.debug(`切换到HDU ${hduIndex}`);
            
            const hduData = await this.dataManager.getHDUData(uri, hduIndex);
            if (!hduData) {
                throw new Error(`无法获取HDU ${hduIndex} 的数据`);
            }
            
            await this.sendHeaderInfo(uri, webviewPanel, hduIndex);
            
            // 根据HDU类型处理数据
            if (hduData.type === HDUType.IMAGE) {
                // 显示图像缩放按钮，隐藏光谱列选择器
                webviewPanel.webview.postMessage({
                    command: 'setControlsVisibility',
                    showImageControls: true,
                    showSpectrumControls: false
                });
                
                await this.processImageHDU(uri, hduData, webviewPanel);
            } else if (hduData.type === HDUType.BINTABLE || hduData.type === HDUType.TABLE) {
                // 隐藏图像缩放按钮，显示光谱列选择器
                webviewPanel.webview.postMessage({
                    command: 'setControlsVisibility',
                    showImageControls: false,
                    showSpectrumControls: true
                });
                
                await this.processTableHDU(hduData, webviewPanel);
            } else {
                await this.processUnknownHDU(uri, hduData, webviewPanel);
            }
            
        } catch (error) {
            this.logger.error('切换HDU时出错:', error);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 
                `切换HDU失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 加载FITS文件
     */
    private async loadFITS(fileUri: vscode.Uri): Promise<FITS> {
        this.logger.info('开始加载FITS文件...');
        try {
            // 读取FITS文件
            this.logger.debug(`尝试读取文件: ${fileUri.fsPath}`);
            const fitsData = await fs.promises.readFile(fileUri.fsPath);
            this.logger.debug(`已读取FITS文件，大小: ${fitsData.length} 字节`);
            
            this.logger.debug('开始解析FITS数据...');
            const parser = new FITSParser();
            const fits = parser.parseFITS(new Uint8Array(fitsData));
            this.logger.debug('FITS数据解析完成');
            
            // 加载到数据管理器
            this.logger.debug('正在加载到数据管理器...');
            await this.dataManager.loadFITS(fileUri, fits);
            this.currentFileUri = fileUri;
            this.logger.info('FITS文件加载完成');
            
            return fits;
        } catch (error) {
            this.logger.error(`加载FITS文件失败: ${error}`);
            throw error;
        }
    }

    /**
     * 更新webview内容
     */
    private async updateWebview(fileUri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const uriString = fileUri.toString();

        if (this.loadingManager.isLoading(uriString)) {
            this.webviewService.sendLoadingMessage(webviewPanel.webview, '文件正在加载中，请稍候...');
            return;
        }

        try {
            this.webviewService.sendLoadingMessage(webviewPanel.webview, '正在解析FITS文件，请稍候...');
            
            const fits = await this.loadFITS(fileUri);
            
            this.webviewService.sendHDUCount(webviewPanel.webview, this.dataManager.getHDUCount(fileUri));
            
            // 确定要显示的HDU索引
            // 如果有扩展HDU（总数>1），则显示第一个扩展HDU（索引为1）
            const hduCount = this.dataManager.getHDUCount(fileUri);
            const defaultHduIndex = hduCount > 1 ? 1 : 0;
            
            // 设置当前HDU索引
            this.currentHDUIndex.set(uriString, defaultHduIndex);
            this.logger.debug(`默认显示HDU ${defaultHduIndex}`);
            
            // 发送消息更新HDU选择器的选中状态
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setSelectedHDU',
                hduIndex: defaultHduIndex
            });
            
            await this.sendHeaderInfo(fileUri, webviewPanel, defaultHduIndex);
            
            const hduData = await this.dataManager.getHDUData(fileUri, defaultHduIndex);
            if (!hduData) {
                throw new Error('无法获取HDU数据');
            }
            
            // 发送文件名
            const fileName = path.basename(fileUri.fsPath);
            this.webviewService.sendFileName(webviewPanel.webview, fileName);
            
            // 发送对象名称
            const header = this.dataManager.getHDUHeader(fileUri, defaultHduIndex);
            const objectName = header?.getItem('OBJECT')?.value || '未知对象';
            this.webviewService.sendObjectName(webviewPanel.webview, objectName);
            
            // 发送头信息摘要
            if (header) {
                this.webviewService.sendHeaderSummary(webviewPanel.webview, header.getAllItems());
            }
            
            // 根据HDU类型处理数据
            if (hduData.type === HDUType.IMAGE) {
                // 显示图像缩放按钮，隐藏光谱列选择器
                webviewPanel.webview.postMessage({
                    command: 'setControlsVisibility',
                    showImageControls: true,
                    showSpectrumControls: false
                });
                
                await this.processImageHDU(fileUri, hduData, webviewPanel);
            } else if (hduData.type === HDUType.BINTABLE || hduData.type === HDUType.TABLE) {
                // 隐藏图像缩放按钮，显示光谱列选择器
                webviewPanel.webview.postMessage({
                    command: 'setControlsVisibility',
                    showImageControls: false,
                    showSpectrumControls: true
                });
                
                await this.processTableHDU(hduData, webviewPanel);
            } else {
                await this.processUnknownHDU(fileUri, hduData, webviewPanel);
            }
            
        } catch (error) {
            this.logger.error('处理FITS文件时出错:', error);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 
                `无法显示FITS图像: ${error instanceof Error ? error.message : String(error)}`);
            vscode.window.showErrorMessage(`无法打开FITS文件: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    /**
     * 处理图像类型的HDU
     */
    private async processImageHDU(fileUri: vscode.Uri, hduData: any, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            // 检查是否是多维数据
            const header = this.dataManager.getHDUHeader(fileUri, 0);
            const naxis = header?.getItem('NAXIS')?.value || 0;
            
            // 创建元数据对象
            const metadata: any = {
                width: hduData.width,
                height: hduData.height,
                min: hduData.stats.min,
                max: hduData.stats.max
            };
            
            // 如果是3D或更高维度的数据，添加深度信息
            if (naxis > 2) {
                const naxis3 = header?.getItem('NAXIS3')?.value || 1;
                metadata.depth = naxis3;
                this.logger.debug(`检测到多维数据，深度: ${naxis3}`);
            }
            
            // 创建临时文件
            const metadataBuffer = Buffer.from(JSON.stringify(metadata));
            
            // 创建头部长度指示器
            const headerLengthBuffer = Buffer.alloc(4);
            headerLengthBuffer.writeUInt32LE(metadataBuffer.length, 0);
            
            // 创建数据缓冲区
            const dataBuffer = Buffer.from(hduData.data.buffer);
            
            // 合并所有数据
            const combinedBuffer = Buffer.concat([
                headerLengthBuffer,
                metadataBuffer,
                dataBuffer
            ]);
            
            // 创建临时文件
            const tempFilePath = await this.dataManager.createTempFile(fileUri, combinedBuffer);
            
            // 发送文件URI到webview
            this.webviewService.sendImageDataFileUri(webviewPanel.webview, vscode.Uri.file(tempFilePath));
            
        } catch (error) {
            this.logger.error('创建临时文件时出错:', error);
            
            // 如果二进制传输失败，回退到JSON方式
            this.logger.debug('回退到JSON传输方式');
            
            // 检查是否是多维数据
            const header = this.dataManager.getHDUHeader(fileUri, 0);
            const naxis = header?.getItem('NAXIS')?.value || 0;
            const rawData: any = {
                data: Array.from(hduData.data),
                width: hduData.width,
                height: hduData.height,
                min: hduData.stats.min,
                max: hduData.stats.max
            };
            
            // 如果是3D或更高维度的数据，添加深度信息
            if (naxis > 2) {
                const naxis3 = header?.getItem('NAXIS3')?.value || 1;
                rawData.depth = naxis3;
                this.logger.debug(`检测到多维数据，深度: ${naxis3}`);
            }
            
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setImageData',
                rawData: rawData
            });
        }
    }
    
    /**
     * 处理表格类型的HDU
     */
    private async processTableHDU(hduData: any, webviewPanel: vscode.WebviewPanel): Promise<void> {
        if (hduData.columns) {
            this.logger.debug('发现列数据，开始处理光谱...');
            this.logger.debug('可用列:', Array.from(hduData.columns.keys()));
            
            // 准备列信息数组，用于发送到webview
            const columnsInfo = Array.from(hduData.columns.entries()).map(entry => {
                const [name, column] = entry as [string, any];
                return {
                    name: name,
                    unit: column.unit,
                    dataType: column.dataType,
                    length: column.data.length
                };
            });
            
            // 查找波长和流量列（不区分大小写）
            let wavelengthData: number[] | undefined;
            let fluxData: number[] | undefined;
            let wavelengthUnit: string | undefined;
            let fluxUnit: string | undefined;
            let wavelengthColumn: string | undefined;
            let fluxColumn: string | undefined;

            // 优先查找常见的波长和流量列名
            for (const [name, column] of hduData.columns) {
                const columnNameLower = name.toLowerCase();
                this.logger.debug(`处理列: ${name}, 数据类型: ${column.dataType}, 单位: ${column.unit || '无'}`);
                
                if (columnNameLower.includes('wavelength') || columnNameLower === 'wave' || columnNameLower === 'lambda') {
                    this.logger.debug(`找到波长列: ${name}`);
                    wavelengthColumn = name;
                    wavelengthUnit = column.unit;
                } else if (columnNameLower.includes('flux') || columnNameLower === 'data' || columnNameLower === 'intensity') {
                    this.logger.debug(`找到流量列: ${name}`);
                    fluxColumn = name;
                    fluxUnit = column.unit;
                }
            }

            // 如果没有找到波长列，选择第一列作为波长
            if (!wavelengthColumn && columnsInfo.length > 0) {
                wavelengthColumn = columnsInfo[0].name;
                const column = hduData.columns.get(wavelengthColumn);
                wavelengthUnit = column?.unit;
                this.logger.debug(`未找到明确的波长列，使用第一列 ${wavelengthColumn} 作为波长`);
            }

            // 如果没有找到流量列，选择第二列作为流量
            if (!fluxColumn && columnsInfo.length > 1) {
                fluxColumn = columnsInfo[1].name;
                const column = hduData.columns.get(fluxColumn);
                fluxUnit = column?.unit;
                this.logger.debug(`未找到明确的流量列，使用第二列 ${fluxColumn} 作为流量`);
            } else if (!fluxColumn && columnsInfo.length === 1) {
                // 如果只有一列，创建一个序号数组作为波长，使用该列作为流量
                wavelengthColumn = 'pixel';
                wavelengthUnit = 'pixel';
                fluxColumn = columnsInfo[0].name;
                const column = hduData.columns.get(fluxColumn);
                fluxUnit = column?.unit;
                this.logger.debug(`只有一列数据，使用像素索引作为波长，使用 ${fluxColumn} 作为流量`);
            }

            // 获取选定列的数据
            if (wavelengthColumn && wavelengthColumn !== 'pixel') {
                const column = hduData.columns.get(wavelengthColumn);
                if (column && column.data) {
                    // 对于大型数据，进行采样以提高性能
                    const dataLength = column.data.length;
                    if (dataLength > 10000) {
                        this.logger.debug(`波长数据过大 (${dataLength} 点)，进行采样`);
                        const samplingRate = Math.ceil(dataLength / 10000);
                        wavelengthData = [];
                        for (let i = 0; i < dataLength; i += samplingRate) {
                            wavelengthData.push(column.data[i]);
                        }
                        this.logger.debug(`采样后波长数据点数: ${wavelengthData.length}`);
                    } else {
                        wavelengthData = Array.from(column.data);
                    }
                }
            }

            if (fluxColumn) {
                const column = hduData.columns.get(fluxColumn);
                if (column && column.data) {
                    // 对于大型数据，进行采样以提高性能
                    const dataLength = column.data.length;
                    if (dataLength > 10000) {
                        this.logger.debug(`流量数据过大 (${dataLength} 点)，进行采样`);
                        const samplingRate = Math.ceil(dataLength / 10000);
                        fluxData = [];
                        for (let i = 0; i < dataLength; i += samplingRate) {
                            fluxData.push(column.data[i]);
                        }
                        this.logger.debug(`采样后流量数据点数: ${fluxData.length}`);
                    } else {
                        fluxData = Array.from(column.data);
                    }
                }
            }

            // 如果波长列是'pixel'，创建一个与流量数据等长的序号数组
            if (wavelengthColumn === 'pixel' && fluxData) {
                wavelengthData = Array.from({ length: fluxData.length }, (_, i) => i);
                this.logger.debug(`创建了 ${wavelengthData.length} 个像素索引作为波长数据`);
            }

            // 发送光谱数据到webview
            if (wavelengthData && fluxData) {
                this.logger.debug('准备发送光谱数据到webview');
                this.logger.debug(`波长数据长度: ${wavelengthData.length}, 单位: ${wavelengthUnit}`);
                this.logger.debug(`流量数据长度: ${fluxData.length}, 单位: ${fluxUnit}`);
                
                // 确保波长和流量数据长度一致
                const minLength = Math.min(wavelengthData.length, fluxData.length);
                if (wavelengthData.length !== fluxData.length) {
                    this.logger.debug(`波长和流量数据长度不一致，截断至 ${minLength}`);
                    wavelengthData = wavelengthData.slice(0, minLength);
                    fluxData = fluxData.slice(0, minLength);
                }
                
                this.webviewService.sendSpectrumData(
                    webviewPanel.webview, 
                    wavelengthData, 
                    fluxData, 
                    wavelengthUnit, 
                    fluxUnit,
                    columnsInfo,
                    wavelengthColumn,
                    fluxColumn
                );
                
                this.logger.debug('光谱数据已发送到webview');
            } else {
                this.logger.debug('未能找到有效的波长或流量数据');
                this.webviewService.sendLoadingMessage(webviewPanel.webview, '无法显示光谱：未找到有效的波长或流量数据');
            }
        } else {
            this.logger.debug('未找到列数据');
            this.webviewService.sendLoadingMessage(webviewPanel.webview, '无法显示光谱：未找到列数据');
        }
    }
    
    /**
     * 处理未知类型的HDU
     */
    private async processUnknownHDU(fileUri: vscode.Uri, hduData: any, webviewPanel: vscode.WebviewPanel): Promise<void> {
        // 对于未知类型，尝试根据维度判断
        const header = this.dataManager.getHDUHeader(fileUri, 0);
        if (header) {
            const naxis = header.getItem('NAXIS')?.value || 0;
            const naxis1 = header.getItem('NAXIS1')?.value || 0;
            const naxis2 = header.getItem('NAXIS2')?.value || 0;
            
            if (naxis === 1 || (naxis === 2 && (naxis1 === 1 || naxis2 === 1))) {
                // 可能是一维数据，显示为光谱
                const wavelength = Array.from({ length: hduData.data.length }, (_, i) => i);
                const flux = Array.from(hduData.data).map(value => Number(value));
                
                this.webviewService.sendSpectrumData(webviewPanel.webview, wavelength, flux);
            } else {
                // 尝试作为图像显示
                this.webviewService.postMessage(webviewPanel.webview, {
                    command: 'setImageData',
                    rawData: {
                        data: Array.from(hduData.data),
                        width: hduData.width || naxis1,
                        height: hduData.height || naxis2,
                        min: hduData.stats.min,
                        max: hduData.stats.max
                    }
                });
            }
        }
    }
    
    /**
     * 发送头信息到webview
     */
    private async sendHeaderInfo(fileUri: vscode.Uri, webviewPanel: vscode.WebviewPanel, hduIndex: number = 0): Promise<void> {
        try {
            const header = this.dataManager.getHDUHeader(fileUri, hduIndex);
            if (!header) {
                throw new Error('无法获取头信息');
            }
            
            const headerItems = header.getAllItems();
            this.webviewService.sendHeaderInfo(webviewPanel.webview, headerItems);
            
        } catch (error) {
            this.logger.error('发送头信息时出错:', error);
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setHeaderInfo',
                html: `<p class="error">无法获取头信息: ${error instanceof Error ? error.message : String(error)}</p>`
            });
        }
    }

    /**
     * 处理更新光谱请求
     */
    public async handleUpdateSpectrum(uri: vscode.Uri, wavelengthColumn: string, fluxColumn: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        this.logger.debug(`处理更新光谱请求: 波长列=${wavelengthColumn}, 流量列=${fluxColumn}`);
        
        try {
            // 获取当前HDU索引
            const hduIndex = this.currentHDUIndex.get(uri.toString()) || 0;
            
            // 获取HDU数据
            const hduData = await this.dataManager.getHDUData(uri, hduIndex);
            if (!hduData || !hduData.columns) {
                this.logger.error('无法获取HDU数据或列数据');
                return;
            }
            
            // 准备列信息数组，用于发送到webview
            const columnsInfo = Array.from(hduData.columns.entries()).map(entry => {
                const [name, column] = entry as [string, any];
                return {
                    name: name,
                    unit: column.unit,
                    dataType: column.dataType,
                    length: column.data.length
                };
            });
            
            // 获取波长和流量数据
            let wavelengthData: number[] | undefined;
            let fluxData: number[] | undefined;
            let wavelengthUnit: string | undefined;
            let fluxUnit: string | undefined;
            
            // 处理波长列
            if (wavelengthColumn === 'pixel') {
                // 如果选择了"pixel"，创建一个序号数组
                const fluxCol = hduData.columns.get(fluxColumn);
                if (fluxCol) {
                    wavelengthData = Array.from({ length: fluxCol.data.length }, (_, i) => i);
                    wavelengthUnit = 'pixel';
                }
            } else {
                // 否则，使用选择的列
                const wavelengthCol = hduData.columns.get(wavelengthColumn);
                if (wavelengthCol) {
                    wavelengthData = Array.from(wavelengthCol.data);
                    wavelengthUnit = wavelengthCol.unit;
                }
            }
            
            // 处理流量列
            const fluxCol = hduData.columns.get(fluxColumn);
            if (fluxCol) {
                fluxData = Array.from(fluxCol.data);
                fluxUnit = fluxCol.unit;
            }
            
            // 发送更新后的光谱数据到webview
            if (wavelengthData && fluxData) {
                this.logger.debug('准备发送更新后的光谱数据到webview');
                this.logger.debug(`波长数据长度: ${wavelengthData.length}, 单位: ${wavelengthUnit}`);
                this.logger.debug(`流量数据长度: ${fluxData.length}, 单位: ${fluxUnit}`);
                
                this.webviewService.sendSpectrumData(
                    webviewPanel.webview, 
                    wavelengthData, 
                    fluxData, 
                    wavelengthUnit, 
                    fluxUnit,
                    columnsInfo,
                    wavelengthColumn,
                    fluxColumn
                );
                
                this.logger.debug('更新后的光谱数据已发送到webview');
            } else {
                this.logger.error('未能获取有效的波长或流量数据');
                this.webviewService.sendLoadingMessage(webviewPanel.webview, '无法更新光谱：未找到有效的波长或流量数据');
            }
        } catch (error) {
            this.logger.error(`更新光谱时出错: ${error}`);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, `更新光谱时出错: ${error}`);
        }
    }
} 