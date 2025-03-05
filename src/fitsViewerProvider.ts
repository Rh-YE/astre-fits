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

// Table field description class | 表格字段描述类
class TableField {
    constructor(
        public readonly index: number,        // Field index | 字段索引
        public readonly repeatCount: number,  // Repeat count | 重复计数
        public readonly dataType: string,     // Data type | 数据类型
        public readonly byteSize: number      // Byte size | 字节大小
    ) {}

    // Get total bytes of field | 获取字段总字节数
    getTotalBytes(): number {
        return this.repeatCount * this.byteSize;
    }
}

// FITS table parser class | FITS表格解析器类
class FITSTableParser {
    // Data type byte size mapping | 数据类型字节映射表
    private static readonly TYPE_BYTE_SIZES = new Map<string, number>([
        ['L', 1],  // Logical | 逻辑型
        ['X', 1],  // Bit | 位
        ['B', 1],  // Unsigned byte | 无符号字节
        ['I', 2],  // 16-bit integer | 16位整数
        ['J', 4],  // 32-bit integer | 32位整数
        ['K', 8],  // 64-bit integer | 64位整数
        ['A', 1],  // Character | 字符
        ['E', 4],  // Single-precision floating point | 单精度浮点
        ['D', 8],  // Double-precision floating point | 双精度浮点
        ['C', 8],  // Single-precision complex | 单精度复数
        ['M', 16], // Double-precision complex | 双精度复数
        ['P', 8],  // Array Descriptor (32-bit) | 数组描述符(32位)
        ['Q', 16], // Array Descriptor (64-bit) | 数组描述符(64位)
    ]);

    // Parse TFORM value | 解析TFORM值
    static parseFormat(tform: string): { repeatCount: number, dataType: string } {
        const match = tform.match(/^(\d*)([A-Z])/);
        if (!match) {
            throw new Error('Invalid TFORM format');
        }
        return {
            repeatCount: match[1] ? parseInt(match[1]) : 1,
            dataType: match[2]
        };
    }

    // Get byte size of data type | 获取数据类型的字节大小
    static getTypeByteSize(dataType: string): number {
        const size = this.TYPE_BYTE_SIZES.get(dataType);
        if (size === undefined) {
            throw new Error('Unknown data type');
        }
        return size;
    }
}

/**
 * FITS file viewer provider | FITS文件查看器提供程序
 * Implements VSCode custom editor interface to provide FITS file viewing functionality | 实现VSCode自定义编辑器接口，提供FITS文件查看功能
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
        // this.logger.info('FitsViewerProvider created');
        
        this.dataManager = FITSDataManager.getInstance(context);
        this.loadingManager = LoadingManager.getInstance();
        this.webviewService = new WebviewService(context);
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        // this.logger.info(`Opening file: ${uri.fsPath}`);
        try {
            // Verify file exists | 验证文件是否存在
            await vscode.workspace.fs.stat(uri);
            this.logger.debug('File exists, continue processing');
            return { uri, dispose: () => { } };
        } catch (error) {
            this.logger.error(`Failed to open file: ${error}`);
            throw error;
        }
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        // this.logger.info('Resolving custom editor');
        
        // Configure webview | 配置webview
        this.webviewService.configureWebview(webviewPanel.webview);
        
        // Set HTML content | 设置HTML内容
        webviewPanel.webview.html = this.webviewService.getHtmlForWebview(webviewPanel.webview);
        this.logger.debug('Webview HTML set');
        
        // Create message handler | 创建消息处理器
        const messageHandler = new WebviewMessageHandler(this);
        
        // Handle webview messages | 处理webview消息
        webviewPanel.webview.onDidReceiveMessage(message => {
            messageHandler.handleMessage(message, document, webviewPanel);
        });
        
        // Clear cache when editor closes | 当编辑器关闭时清除缓存
        webviewPanel.onDidDispose(() => {
            if (document.uri) {
                this.dataManager.clearCache(document.uri);
                this.currentFileUri = undefined;
                // this.logger.info(`Cache cleared for file: ${document.uri.fsPath}`);
            }
        });
    }

    /**
     * Handle webview ready message | 处理webview准备就绪消息
     */
    async handleWebviewReady(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        // this.logger.info('Webview ready, starting data update');
        await this.updateWebview(uri, webviewPanel);
    }

    /**
     * Handle get pixel value message | 处理获取像素值消息
     */
    async handleGetPixelValue(uri: vscode.Uri, x: number, y: number, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            // Get current HDU index | 获取当前HDU索引
            const uriString = uri.toString();
            const currentHduIndex = this.currentHDUIndex.get(uriString) || 0;
            
            const hduData = await this.dataManager.getHDUData(uri, currentHduIndex);
            if (!hduData || hduData.type !== HDUType.IMAGE) {
                throw new Error('Cannot get image data');
            }
            
            // Check if coordinates are within image bounds | 检查坐标是否在图像范围内
            if (!hduData.width || !hduData.height || x < 0 || x >= hduData.width || y < 0 || y >= hduData.height) {
                throw new Error('Coordinates out of image bounds');
            }
            
            // Get pixel value | 获取像素值
            const pixelValue = hduData.data[y * hduData.width + x];
            
            // Calculate WCS coordinates if available | 计算WCS坐标（如果有）
            let wcs1 = '-';
            let wcs2 = '-';
            const header = this.dataManager.getHDUHeader(uri, currentHduIndex);
            if (header) {
                // Get reference pixels and values | 获取参考像素和值
                const crpix1 = header.getItem('CRPIX1')?.value;
                const crpix2 = header.getItem('CRPIX2')?.value;
                const crval1 = header.getItem('CRVAL1')?.value;
                const crval2 = header.getItem('CRVAL2')?.value;

                // Check for different WCS representations | 检查不同的WCS表示方式
                if (crpix1 !== undefined && crpix2 !== undefined &&
                    crval1 !== undefined && crval2 !== undefined) {
                    
                    let dx = x + 1 - crpix1;  // Convert to 1-based FITS coordinate | 转换为1-based的FITS坐标
                    let dy = y + 1 - crpix2;
                    let ra = crval1;
                    let dec = crval2;

                    // Try CD matrix first | 首先尝试CD矩阵
                    const cd1_1 = header.getItem('CD1_1')?.value;
                    const cd1_2 = header.getItem('CD1_2')?.value;
                    const cd2_1 = header.getItem('CD2_1')?.value;
                    const cd2_2 = header.getItem('CD2_2')?.value;

                    if (cd1_1 !== undefined && cd1_2 !== undefined &&
                        cd2_1 !== undefined && cd2_2 !== undefined) {
                        // Use CD matrix transformation | 使用CD矩阵变换
                        ra += cd1_1 * dx + cd1_2 * dy;
                        dec += cd2_1 * dx + cd2_2 * dy;
                        this.logger.debug('Using CD matrix for WCS calculation');
                    } else {
                        // Try PC matrix with CDELT | 尝试PC矩阵和CDELT
                        const cdelt1 = header.getItem('CDELT1')?.value;
                        const cdelt2 = header.getItem('CDELT2')?.value;
                        const pc1_1 = header.getItem('PC1_1')?.value ?? 1;
                        const pc1_2 = header.getItem('PC1_2')?.value ?? 0;
                        const pc2_1 = header.getItem('PC2_1')?.value ?? 0;
                        const pc2_2 = header.getItem('PC2_2')?.value ?? 1;

                        if (cdelt1 !== undefined && cdelt2 !== undefined) {
                            // Use PC matrix with CDELT | 使用PC矩阵和CDELT
                            ra += cdelt1 * (pc1_1 * dx + pc1_2 * dy);
                            dec += cdelt2 * (pc2_1 * dx + pc2_2 * dy);
                            this.logger.debug('Using PC matrix with CDELT for WCS calculation');
                        } else {
                            // Try simple CDELT only | 只尝试简单的CDELT
                            const cdelt1 = header.getItem('CDELT1')?.value;
                            const cdelt2 = header.getItem('CDELT2')?.value;
                            
                            if (cdelt1 !== undefined && cdelt2 !== undefined) {
                                // Use simple scaling | 使用简单的缩放
                                ra += cdelt1 * dx;
                                dec += cdelt2 * dy;
                                this.logger.debug('Using simple CDELT for WCS calculation');
                            } else {
                                this.logger.debug('No valid WCS transformation found');
                                ra = dec = undefined;
                            }
                        }
                    }

                    if (ra !== undefined && dec !== undefined) {
                        wcs1 = `RA: ${ra.toFixed(6)}°`;
                        wcs2 = `Dec: ${dec.toFixed(6)}°`;
                        
                        this.logger.debug('Calculated WCS coordinates:', {
                            x, y,
                            ra, dec,
                            wcs1, wcs2
                        });
                    }
                } else {
                    this.logger.debug('Missing basic WCS keywords (CRPIX/CRVAL) in header');
                }
            } else {
                this.logger.debug('No header information available');
            }
            
            // Send pixel value and WCS coordinates to webview | 发送像素值和WCS坐标到webview
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setPixelValue',
                value: pixelValue.toString(),
                wcs1: wcs1,
                wcs2: wcs2
            });
            
        } catch (error) {
            this.logger.error('Error getting pixel value:', error);
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setPixelValue',
                value: 'error',
                wcs1: 'error',
                wcs2: 'error'
            });
        }
    }

    /**
     * Handle set scale type message | 处理设置缩放类型消息
     */
    async handleSetScaleType(uri: vscode.Uri, scaleType: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            // Get current HDU data | 获取当前HDU索引
            const uriString = uri.toString();
            const currentHduIndex = this.currentHDUIndex.get(uriString) || 0;
            
            const hduData = await this.dataManager.getHDUData(uri, currentHduIndex);
            if (!hduData || hduData.type !== HDUType.IMAGE) {
                throw new Error('Cannot get image data');
            }

            // Get transform type from active button | 获取变换类型
            const transformType = await new Promise<string>((resolve) => {
                const messageHandler = (message: any) => {
                    if (message.command === 'transformTypeResponse') {
                        webviewPanel.webview.onDidReceiveMessage(messageHandler);
                        resolve(message.transformType || 'linear');
                    }
                };
                webviewPanel.webview.onDidReceiveMessage(messageHandler);
                webviewPanel.webview.postMessage({ command: 'getTransformType' });
            });

            // Get bias and contrast values | 获取偏差和对比度值
            const { biasValue, contrastValue } = await new Promise<{biasValue: number, contrastValue: number}>((resolve) => {
                const messageHandler = (message: any) => {
                    if (message.command === 'scaleValuesResponse') {
                        webviewPanel.webview.onDidReceiveMessage(messageHandler);
                        resolve({
                            biasValue: message.biasValue || 0.5,
                            contrastValue: message.contrastValue || 1.0
                        });
                    }
                };
                webviewPanel.webview.onDidReceiveMessage(messageHandler);
                webviewPanel.webview.postMessage({ command: 'getScaleValues' });
            });

            // Apply scale transform | 应用缩放变换
            const transformResult = await FITSDataProcessor.applyScaleTransform(
                hduData,
                scaleType,
                transformType,
                biasValue,
                contrastValue
            );
            
            // Create temporary file | 创建临时文件
            const metadataBuffer = Buffer.from(JSON.stringify({
                width: transformResult.width,
                height: transformResult.height,
                depth: transformResult.depth,
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
            
            // Send file URI to webview | 发送文件URI到webview
            this.webviewService.sendImageDataFileUri(webviewPanel.webview, vscode.Uri.file(tempFilePath));
            
        } catch (error) {
            this.logger.error('Error setting scale type:', error);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 
                `Cannot apply scale: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Handle get header info message | 处理获取头信息消息
     */
    async handleGetHeaderInfo(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        // Get current HDU index | 获取当前HDU索引
        const uriString = uri.toString();
        const currentHduIndex = this.currentHDUIndex.get(uriString) || 0;
        
        await this.sendHeaderInfo(uri, webviewPanel, currentHduIndex);
    }

    /**
     * Handle switch HDU message | 处理切换HDU消息
     */
    async handleSwitchHDU(uri: vscode.Uri, hduIndex: number, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const uriString = uri.toString();

        if (this.loadingManager.isLoading(uriString)) {
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 'Switching HDU, please wait...');
            return;
        }

        try {
            // Update current HDU index | 更新当前HDU索引
            this.currentHDUIndex.set(uriString, hduIndex);
            this.logger.debug(`Switched to HDU ${hduIndex}`);
            
            const hduData = await this.dataManager.getHDUData(uri, hduIndex);
            if (!hduData) {
                throw new Error(`Cannot get data for HDU ${hduIndex}`);
            }
            
            await this.sendHeaderInfo(uri, webviewPanel, hduIndex);
            
            // Process data based on HDU type | 根据HDU类型处理数据
            if (hduData.type === HDUType.IMAGE) {
                // Show image controls, hide spectrum controls | 显示图像缩放按钮，隐藏光谱列选择器
                webviewPanel.webview.postMessage({
                    command: 'setControlsVisibility',
                    showImageControls: true,
                    showSpectrumControls: false
                });
                
                await this.processImageHDU(uri, hduData, webviewPanel);
            } else if (hduData.type === HDUType.BINTABLE || hduData.type === HDUType.TABLE) {
                // Hide image controls, show spectrum controls | 隐藏图像缩放按钮，显示光谱列选择器
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
            this.logger.error('Error switching HDU:', error);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 
                `Failed to switch HDU: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Load FITS file | 加载FITS文件
     */
    private async loadFITS(fileUri: vscode.Uri): Promise<FITS> {
        // this.logger.info('Starting to load FITS file...');
        try {
            // Read FITS file | 读取FITS文件
            this.logger.debug(`Trying to read file: ${fileUri.fsPath}`);
            const fitsData = await fs.promises.readFile(fileUri.fsPath);
            this.logger.debug(`FITS file read, size: ${fitsData.length} bytes`);
            
            this.logger.debug('Starting to parse FITS data...');
            const parser = new FITSParser();
            const fits = parser.parseFITS(new Uint8Array(fitsData));
            this.logger.debug('FITS data parsing complete');
            
            // Load to data manager | 加载到数据管理器
            this.logger.debug('Loading to data manager...');
            await this.dataManager.loadFITS(fileUri, fits);
            this.currentFileUri = fileUri;
            // this.logger.info('FITS file loading complete');
            
            return fits;
        } catch (error) {
            this.logger.error(`Failed to load FITS file: ${error}`);
            throw error;
        }
    }

    /**
     * Update webview content | 更新webview内容
     */
    private async updateWebview(fileUri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const uriString = fileUri.toString();

        if (this.loadingManager.isLoading(uriString)) {
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 'File is loading, please wait...');
            return;
        }

        try {
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 'Parsing FITS file, please wait...');
            
            const fits = await this.loadFITS(fileUri);
            
            this.webviewService.sendHDUCount(webviewPanel.webview, this.dataManager.getHDUCount(fileUri));
            
            // Determine HDU index to display | 确定要显示的HDU索引
            // If there are extension HDUs (total > 1), show first extension HDU (index 1) | 如果有扩展HDU（总数>1），则显示第一个扩展HDU（索引为1）
            const hduCount = this.dataManager.getHDUCount(fileUri);
            const defaultHduIndex = hduCount > 1 ? 1 : 0;
            
            // Set current HDU index | 设置当前HDU索引
            this.currentHDUIndex.set(uriString, defaultHduIndex);
            this.logger.debug(`Default showing HDU ${defaultHduIndex}`);
            
            // Send message to update HDU selector state | 发送消息更新HDU选择器的选中状态
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setSelectedHDU',
                hduIndex: defaultHduIndex
            });
            
            await this.sendHeaderInfo(fileUri, webviewPanel, defaultHduIndex);
            
            const hduData = await this.dataManager.getHDUData(fileUri, defaultHduIndex);
            if (!hduData) {
                throw new Error('Cannot get HDU data');
            }
            
            // Send filename | 发送文件名
            const fileName = path.basename(fileUri.fsPath);
            this.webviewService.sendFileName(webviewPanel.webview, fileName);
            
            // Send object name | 发送对象名称
            const header = this.dataManager.getHDUHeader(fileUri, defaultHduIndex);
            const objectName = header?.getItem('OBJECT')?.value || 'Unknown Object';
            this.webviewService.sendObjectName(webviewPanel.webview, objectName);
            
            // Send header summary | 发送头信息摘要
            if (header) {
                this.webviewService.sendHeaderSummary(webviewPanel.webview, header.getAllItems());
            }
            
            // Process data based on HDU type | 根据HDU类型处理数据
            if (hduData.type === HDUType.IMAGE) {
                // Show image controls, hide spectrum controls | 显示图像缩放按钮，隐藏光谱列选择器
                webviewPanel.webview.postMessage({
                    command: 'setControlsVisibility',
                    showImageControls: true,
                    showSpectrumControls: false
                });
                
                await this.processImageHDU(fileUri, hduData, webviewPanel);
            } else if (hduData.type === HDUType.BINTABLE || hduData.type === HDUType.TABLE) {
                // Hide image controls, show spectrum controls | 隐藏图像缩放按钮，显示光谱列选择器
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
            this.logger.error('Error processing FITS file:', error);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 
                `Cannot display FITS image: ${error instanceof Error ? error.message : String(error)}`);
            vscode.window.showErrorMessage(`Cannot open FITS file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    /**
     * Process image type HDU | 处理图像类型的HDU
     */
    private async processImageHDU(fileUri: vscode.Uri, hduData: any, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            // Check if multi-dimensional data | 检查是否是多维数据
            const header = this.dataManager.getHDUHeader(fileUri, 0);
            const naxis = header?.getItem('NAXIS')?.value || 0;
            
            // Create metadata object | 创建元数据对象
            const metadata: any = {
                width: hduData.width,
                height: hduData.height,
                min: hduData.stats.min,
                max: hduData.stats.max
            };
            
            // Add depth info for 3D or higher dimensional data | 如果是3D或更高维度的数据，添加深度信息
            if (naxis > 2) {
                const naxis3 = header?.getItem('NAXIS3')?.value || 1;
                metadata.depth = naxis3;
                this.logger.debug(`Detected multi-dimensional data, depth: ${naxis3}`);
            }
            
            // Create temporary file | 创建临时文件
            const metadataBuffer = Buffer.from(JSON.stringify(metadata));
            
            // Create header length indicator | 创建头部长度指示器
            const headerLengthBuffer = Buffer.alloc(4);
            headerLengthBuffer.writeUInt32LE(metadataBuffer.length, 0);
            
            // Create data buffer | 创建数据缓冲区
            const dataBuffer = Buffer.from(hduData.data.buffer);
            
            // Merge all data | 合并所有数据
            const combinedBuffer = Buffer.concat([
                headerLengthBuffer,
                metadataBuffer,
                dataBuffer
            ]);
            
            // Create temporary file | 创建临时文件
            const tempFilePath = await this.dataManager.createTempFile(fileUri, combinedBuffer);
            
            // Send file URI to webview | 发送文件URI到webview
            this.webviewService.sendImageDataFileUri(webviewPanel.webview, vscode.Uri.file(tempFilePath));
            
        } catch (error) {
            this.logger.error('Error creating temporary file:', error);
            
            // Fallback to JSON if binary transfer fails | 如果二进制传输失败，回退到JSON方式
            this.logger.debug('Falling back to JSON transfer method');
            
            // Check if multi-dimensional data | 检查是否是多维数据
            const header = this.dataManager.getHDUHeader(fileUri, 0);
            const naxis = header?.getItem('NAXIS')?.value || 0;
            const rawData: any = {
                data: Array.from(hduData.data),
                width: hduData.width,
                height: hduData.height,
                min: hduData.stats.min,
                max: hduData.stats.max
            };
            
            // Add depth info for 3D or higher dimensional data | 如果是3D或更高维度的数据，添加深度信息
            if (naxis > 2) {
                const naxis3 = header?.getItem('NAXIS3')?.value || 1;
                rawData.depth = naxis3;
                this.logger.debug(`Detected multi-dimensional data, depth: ${naxis3}`);
            }
            
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setImageData',
                rawData: rawData
            });
        }
    }
    
    /**
     * Process table type HDU | 处理表格类型的HDU
     */
    private async processTableHDU(hduData: any, webviewPanel: vscode.WebviewPanel): Promise<void> {
        if (hduData.columns) {
            this.logger.debug('Found column data, processing...');
            
            // Prepare column info array | 准备列信息数组
            const columnsInfo = Array.from(hduData.columns.entries()).map(entry => {
                const [name, column] = entry as [string, any];
                return {
                    name: name,
                    unit: column.unit,
                    dataType: column.dataType,
                    length: column.data.length
                };
            });

            // Check if BINTABLE and try to find wavelength and flux columns | 检查是否是BINTABLE并尝试查找波长和流量列
            const isBinTable = hduData.type === HDUType.BINTABLE;
            let hasSpectralData = false;
            let wavelengthColumn: string | undefined;
            let fluxColumn: string | undefined;

            if (isBinTable) {
                // Find wavelength and flux columns (case insensitive) | 查找波长和流量列（不区分大小写）
                for (const [name, column] of hduData.columns) {
                    const columnNameLower = name.toLowerCase();
                    if (columnNameLower.includes('wavelength') || columnNameLower === 'wave' || columnNameLower === 'lambda') {
                        wavelengthColumn = name;
                    } else if (columnNameLower.includes('flux') || columnNameLower === 'data' || columnNameLower === 'intensity') {
                        fluxColumn = name;
                    }
                }
                hasSpectralData = wavelengthColumn !== undefined && fluxColumn !== undefined;
            }

            // Prepare table data | 准备表格数据
            const tableData = {
                columns: columnsInfo,
                rows: [] as any[]
            };

            // Get maximum row count | 获取最大行数
            const maxRows = Math.max(...columnsInfo.map(col => {
                const column = hduData.columns?.get(col.name);
                if (column?.repeatCount === column?.data?.length && typeof column.data[0] === 'number') {
                    return column.data.length;  // If repeatCount equals data length and first element is number, each element is a row | 如果repeatCount等于数据长度且第一个元素是数字，则每个元素都是一行
                }
                return column?.repeatCount === column?.data?.length ? 1 : 
                    (column?.data?.length || 0) / (column?.repeatCount || 1);
            }));
            
            // Build row data | 构建行数据
            for (let i = 0; i < maxRows; i++) {
                const row: any = {};
                for (const col of columnsInfo) {
                    const column = hduData.columns.get(col.name);
                    if (column && column.data) {
                        if (column.dataType === 'A' || column.dataType.endsWith('A')) {
                            // For string type, keep complete string | 对于字符串类型，保持完整字符串
                            const value = column.data[i];
                            // Remove trailing spaces | 去除尾部空格
                            row[col.name] = typeof value === 'string' ? value.trimEnd() : value;
                        } else {
                            // For other types (like numeric) | 对于其他类型（如数值类型）
                            if (column.repeatCount === column.data.length && typeof column.data[0] === 'number') {
                                // If repeatCount equals data length and is numeric type, use value directly | 如果repeatCount等于数据长度且是数值类型，直接使用该值
                                row[col.name] = column.data[i];
                            } else if (column.repeatCount === column.data.length) {
                                // If repeatCount equals data length but not numeric type, this is a single value | 如果repeatCount等于数据长度但不是数值类型，这是一个单一值
                                row[col.name] = column.getValue(i);
                            } else {
                                // Otherwise, this is an array value, need to get corresponding array segment | 否则，这是一个数组值，需要获取对应的数组片段
                                const startIdx = i * column.repeatCount;
                                const endIdx = startIdx + column.repeatCount;
                                if (startIdx < column.data.length) {
                                    if (ArrayBuffer.isView(column.data)) {
                                        row[col.name] = Array.from(column.data.slice(startIdx, endIdx));
                                    } else if (Array.isArray(column.data)) {
                                        row[col.name] = column.data.slice(startIdx, endIdx);
                                    } else {
                                        row[col.name] = null;
                                    }
                                } else {
                                    row[col.name] = null;
                                }
                            }
                        }
                    } else {
                        row[col.name] = null;
                    }
                }
                tableData.rows.push(row);
            }

            // Send table data to webview | 发送表格数据到webview
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setTableData',
                data: tableData
            });

            // If BINTABLE and spectral data found, show spectrum | 如果是BINTABLE且找到了光谱数据，则显示光谱
            if (isBinTable && hasSpectralData) {
                this.logger.debug('Found spectral data, preparing to display spectrum');
                
                const wavelengthCol = hduData.columns.get(wavelengthColumn!);
                const fluxCol = hduData.columns.get(fluxColumn!);
                
                if (wavelengthCol && fluxCol) {
                    const wavelengthData = Array.from(wavelengthCol.data).map(Number);
                    const fluxData = Array.from(fluxCol.data).map(Number);
                    const wavelengthUnit = wavelengthCol.unit;
                    const fluxUnit = fluxCol.unit;

                    // Send spectral data | 发送光谱数据
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

                    // Set controls visibility | 设置控件可见性
                    webviewPanel.webview.postMessage({
                        command: 'setControlsVisibility',
                        showImageControls: false,
                        showSpectrumControls: true,
                        showTableButton: true
                    });
                } else {
                    this.logger.error('Cannot get wavelength or flux column data');
                    this.webviewService.sendLoadingMessage(webviewPanel.webview, 'Cannot display spectrum: Unable to get wavelength or flux column data');
                }
            } else {
                // Show table view | 显示表格视图
                webviewPanel.webview.postMessage({
                    command: 'showTableView',
                    isSpectralData: false
                });
            }
        } else {
            this.logger.debug('No column data found');
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 'Cannot display data: No column data found');
        }
    }

    /**
     * Handle show table request | 处理显示表格请求
     */
    public async handleShowTable(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            const hduIndex = this.currentHDUIndex.get(uri.toString()) || 0;
            const hduData = await this.dataManager.getHDUData(uri, hduIndex);
            
            if (!hduData || !hduData.columns) {
                throw new Error('Cannot get table data');
            }

            // Prepare and send table data | 准备并发送表格数据
            const columnsInfo = Array.from(hduData.columns.entries()).map(entry => {
                const [name, column] = entry as [string, any];
                return {
                    name: name,
                    unit: column.unit,
                    dataType: column.dataType,
                    length: column.data.length
                };
            });

            const maxRows = Math.max(...columnsInfo.map(col => {
                const column = hduData.columns?.get(col.name);
                return column?.data?.length || 0;
            }));
            
            const rows = [];
            
            for (let i = 0; i < maxRows; i++) {
                const row: any = {};
                for (const col of columnsInfo) {
                    const column = hduData.columns.get(col.name);
                    if (column && column.data) {
                        row[col.name] = i < column.data.length ? column.data[i] : null;
                    } else {
                        row[col.name] = null;
                    }
                }
                rows.push(row);
            }

            // Send show table command | 发送显示表格命令
            webviewPanel.webview.postMessage({
                command: 'showTableView',
                isSpectralData: true,
                data: {
                    columns: columnsInfo,
                    rows: rows
                }
            });

            // Update controls visibility | 更新控件可见性
            webviewPanel.webview.postMessage({
                command: 'setControlsVisibility',
                showImageControls: false,
                showSpectrumControls: false,
                showTableButton: true
            });

        } catch (error) {
            this.logger.error('Error showing table:', error);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 
                `Cannot display table: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Process unknown type HDU | 处理未知类型的HDU
     */
    private async processUnknownHDU(fileUri: vscode.Uri, hduData: any, webviewPanel: vscode.WebviewPanel): Promise<void> {
        // Try to determine by dimensions for unknown type | 对于未知类型，尝试根据维度判断
        const header = this.dataManager.getHDUHeader(fileUri, 0);
        if (header) {
            const naxis = header.getItem('NAXIS')?.value || 0;
            const naxis1 = header.getItem('NAXIS1')?.value || 0;
            const naxis2 = header.getItem('NAXIS2')?.value || 0;
            
            if (naxis === 1 || (naxis === 2 && (naxis1 === 1 || naxis2 === 1))) {
                // Might be one-dimensional data, display as spectrum | 可能是一维数据，显示为光谱
                const wavelength = Array.from({ length: hduData.data.length }, (_, i) => i);
                const flux = Array.from(hduData.data).map(value => Number(value));
                
                this.webviewService.sendSpectrumData(webviewPanel.webview, wavelength, flux);
            } else {
                // Try to display as image | 尝试作为图像显示
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
     * Send header information to webview | 发送头信息到webview
     */
    private async sendHeaderInfo(fileUri: vscode.Uri, webviewPanel: vscode.WebviewPanel, hduIndex: number = 0): Promise<void> {
        try {
            const header = this.dataManager.getHDUHeader(fileUri, hduIndex);
            if (!header) {
                throw new Error('Cannot get header information');
            }
            
            const headerItems = header.getAllItems();
            this.webviewService.sendHeaderInfo(webviewPanel.webview, headerItems);
            
        } catch (error) {
            this.logger.error('Error sending header info:', error);
            this.webviewService.postMessage(webviewPanel.webview, {
                command: 'setHeaderInfo',
                html: `<p class="error">Cannot get header info: ${error instanceof Error ? error.message : String(error)}</p>`
            });
        }
    }

    /**
     * Handle update spectrum request | 处理更新光谱请求
     */
    public async handleUpdateSpectrum(uri: vscode.Uri, wavelengthColumn: string, fluxColumn: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        this.logger.debug(`Processing update spectrum request: wavelength=${wavelengthColumn}, flux=${fluxColumn}`);
        
        try {
            // Get current HDU index | 获取当前HDU索引
            const hduIndex = this.currentHDUIndex.get(uri.toString()) || 0;
            
            // Get HDU data | 获取HDU数据
            const hduData = await this.dataManager.getHDUData(uri, hduIndex);
            if (!hduData || !hduData.columns) {
                this.logger.error('Cannot get HDU data or columns');
                return;
            }
            
            // Prepare columns info array for webview | 准备列信息数组用于发送到webview
            const columnsInfo = Array.from(hduData.columns.entries()).map(entry => {
                const [name, column] = entry as [string, any];
                return {
                    name: name,
                    unit: column.unit,
                    dataType: column.dataType,
                    length: column.data.length
                };
            });
            
            // Get wavelength and flux data | 获取波长和流量数据
            let wavelengthData: number[] | undefined;
            let fluxData: number[] | undefined;
            let wavelengthUnit: string | undefined;
            let fluxUnit: string | undefined;
            
            // Process wavelength column | 处理波长列
            if (wavelengthColumn === 'pixel') {
                // Create index array if "pixel" is selected | 如果选择了"pixel"，创建序号数组
                const fluxCol = hduData.columns.get(fluxColumn);
                if (fluxCol) {
                    wavelengthData = Array.from({ length: fluxCol.data.length }, (_, i) => i);
                    wavelengthUnit = 'pixel';
                }
            } else {
                // Use selected column | 使用选择的列
                const wavelengthCol = hduData.columns.get(wavelengthColumn);
                if (wavelengthCol) {
                    wavelengthData = Array.from(wavelengthCol.data);
                    wavelengthUnit = wavelengthCol.unit;
                }
            }
            
            // Process flux column | 处理流量列
            const fluxCol = hduData.columns.get(fluxColumn);
            if (fluxCol) {
                fluxData = Array.from(fluxCol.data);
                fluxUnit = fluxCol.unit;
            }
            
            // Send updated spectrum data to webview | 发送更新后的光谱数据到webview
            if (wavelengthData && fluxData) {
                this.logger.debug('Preparing to send updated spectrum data to webview');
                this.logger.debug(`Wavelength data length: ${wavelengthData.length}, unit: ${wavelengthUnit}`);
                this.logger.debug(`Flux data length: ${fluxData.length}, unit: ${fluxUnit}`);
                
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
                
                this.logger.debug('Updated spectrum data sent to webview');
            } else {
                this.logger.error('Could not get valid wavelength or flux data');
                this.webviewService.sendLoadingMessage(webviewPanel.webview, 'Cannot update spectrum: No valid wavelength or flux data found');
            }
        } catch (error) {
            this.logger.error(`Error updating spectrum: ${error}`);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, `Error updating spectrum: ${error}`);
        }
    }

    /**
     * Handle return to spectrum request | 处理返回光谱请求
     */
    public async handleReturnToSpectrum(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            const hduIndex = this.currentHDUIndex.get(uri.toString()) || 0;
            const hduData = await this.dataManager.getHDUData(uri, hduIndex);
            
            if (!hduData || !hduData.columns) {
                throw new Error('Cannot get data');
            }

            // Find wavelength and flux columns | 查找波长和流量列
            let wavelengthColumn: string | undefined;
            let fluxColumn: string | undefined;

            for (const [name, column] of hduData.columns) {
                const columnNameLower = name.toLowerCase();
                if (columnNameLower.includes('wavelength') || columnNameLower === 'wave' || columnNameLower === 'lambda') {
                    wavelengthColumn = name;
                } else if (columnNameLower.includes('flux') || columnNameLower === 'data' || columnNameLower === 'intensity') {
                    fluxColumn = name;
                }
            }

            if (!wavelengthColumn || !fluxColumn) {
                throw new Error('Wavelength or flux column not found');
            }

            const wavelengthCol = hduData.columns.get(wavelengthColumn);
            const fluxCol = hduData.columns.get(fluxColumn);
            
            if (wavelengthCol && fluxCol) {
                const wavelengthData = Array.from(wavelengthCol.data).map(Number);
                const fluxData = Array.from(fluxCol.data).map(Number);
                const wavelengthUnit = wavelengthCol.unit;
                const fluxUnit = fluxCol.unit;

                // Send spectrum data | 发送光谱数据
                this.webviewService.sendSpectrumData(
                    webviewPanel.webview,
                    wavelengthData,
                    fluxData,
                    wavelengthUnit,
                    fluxUnit,
                    Array.from(hduData.columns.entries()).map(([name, col]: [string, any]) => ({
                        name,
                        unit: col.unit,
                        dataType: col.dataType,
                        length: col.data.length
                    })),
                    wavelengthColumn,
                    fluxColumn
                );

                // Set controls visibility | 设置控件可见性
                webviewPanel.webview.postMessage({
                    command: 'setControlsVisibility',
                    showImageControls: false,
                    showSpectrumControls: true,
                    showTableButton: true
                });
            }
        } catch (error) {
            this.logger.error('Error returning to spectrum:', error);
            this.webviewService.sendLoadingMessage(webviewPanel.webview, 
                `Cannot return to spectrum: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
} 
