import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FITSParser, FITS } from './fitsParser';
import * as crypto from 'crypto';
import { FITSDataManager, HDUType } from './models/FITSDataManager';
import { LoadingManager } from './models/LoadingManager';

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
        ['B', 1],  // Unsigned byte
        ['I', 2],  // 16-bit integer
        ['J', 4],  // 32-bit integer
        ['K', 8],  // 64-bit integer
        ['E', 4],  // 32-bit floating point
        ['D', 8],  // 64-bit floating point
        ['C', 8],  // Complex (2*4 bytes)
        ['M', 16], // Double complex (2*8 bytes)
        ['A', 1],  // Character
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

export class FitsViewerProvider implements vscode.CustomReadonlyEditorProvider {
    
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
    private currentFileUri: vscode.Uri | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        console.log('FitsViewerProvider 已创建');
        this.dataManager = FITSDataManager.getInstance(context);
        this.loadingManager = LoadingManager.getInstance();
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        console.log(`正在打开文件: ${uri.fsPath}`);
        return { uri, dispose: () => { } };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        console.log('正在解析自定义编辑器');
        
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
                vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'fits-temp'))
            ]
        };
        
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
        console.log('已设置webview HTML');
        
        // 处理webview消息
        webviewPanel.webview.onDidReceiveMessage(message => {
            console.log(`收到webview消息: ${message.command}`);
            
            switch (message.command) {
                case 'webviewReady':
                    console.log('Webview已准备好，开始更新数据');
                    this.updateWebview(document.uri, webviewPanel);
                    break;
                case 'getPixelValue':
                    this.getPixelValue(document.uri, message.x, message.y, webviewPanel);
                    break;
                case 'setScaleType':
                    this.setScaleType(document.uri, message.scaleType, webviewPanel);
                    break;
                case 'getHeaderInfo':
                    this.sendHeaderInfo(document.uri, webviewPanel);
                    break;
                case 'switchHDU':
                    this.switchHDU(document.uri, message.hduIndex, webviewPanel);
                    break;
            }
        });
        
        // 当编辑器关闭时清除缓存
        webviewPanel.onDidDispose(() => {
            if (document.uri) {
                this.dataManager.clearCache(document.uri);
                this.currentFileUri = undefined;
                console.log(`已清除文件缓存: ${document.uri.fsPath}`);
            }
        });
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'fitsViewer.html');
        console.log(`HTML文件路径: ${htmlPath.fsPath}`);
        
        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
        console.log('已读取HTML内容');
        
        return htmlContent;
    }

    private async loadFITS(fileUri: vscode.Uri): Promise<FITS> {
        try {
            // 读取FITS文件
            const fitsData = await fs.promises.readFile(fileUri.fsPath);
            console.log(`已读取FITS文件，大小: ${fitsData.length} 字节`);
            
            // 解析FITS文件
            const parser = new FITSParser();
            const fits = parser.parseFITS(new Uint8Array(fitsData));
            
            // 加载到数据管理器
            await this.dataManager.loadFITS(fileUri, fits);
            this.currentFileUri = fileUri;
            
            return fits;
        } catch (error) {
            console.error('解析FITS文件时出错:', error);
            throw error;
        }
    }

    private async updateWebview(fileUri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const uriString = fileUri.toString();

        if (this.loadingManager.isLoading(uriString)) {
            webviewPanel.webview.postMessage({
                command: 'setImageData',
                rawData: null,
                message: '文件正在加载中，请稍候...'
            });
            return;
        }

        try {
            webviewPanel.webview.postMessage({
                command: 'setImageData',
                rawData: null,
                message: '正在解析FITS文件，请稍候...'
            });
            
            const fits = await this.loadFITS(fileUri);
            
            webviewPanel.webview.postMessage({
                command: 'setHDUCount',
                count: this.dataManager.getHDUCount(fileUri)
            });
            
            await this.sendHeaderInfo(fileUri, webviewPanel);
            
            const hduData = await this.dataManager.getHDUData(fileUri, 0);
            if (!hduData) {
                throw new Error('无法获取HDU数据');
            }
            
            // 发送文件名
            const fileName = path.basename(fileUri.fsPath);
            webviewPanel.webview.postMessage({
                command: 'setFileName',
                fileName: fileName
            });
            
            // 发送对象名称
            const header = this.dataManager.getHDUHeader(fileUri, 0);
            const objectName = header?.getItem('OBJECT')?.value || '未知对象';
            webviewPanel.webview.postMessage({
                command: 'setObjectName',
                objectName: objectName
            });
            
            // 发送头信息摘要
            if (header) {
                let headerSummary = '<table style="width:100%">';
                const keyItems = ['BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'DATE-OBS', 'EXPTIME', 'TELESCOP', 'INSTRUME'];
                
                for (const key of keyItems) {
                    const item = header.getItem(key);
                    if (item) {
                        headerSummary += `<tr><td>${key}</td><td>${item.value}</td></tr>`;
                    }
                }
                headerSummary += '</table>';
                
                webviewPanel.webview.postMessage({
                    command: 'setHeaderSummary',
                    html: headerSummary
                });
            }
            
            // 发送图像数据
            if (hduData.type === HDUType.IMAGE) {
                try {
                    // 创建临时文件
                    const metadataBuffer = Buffer.from(JSON.stringify({
                        width: hduData.width,
                        height: hduData.height,
                        min: hduData.stats.min,
                        max: hduData.stats.max
                    }));
                    
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
                    
                    // 创建webview可访问的URI
                    const tempFileUri = webviewPanel.webview.asWebviewUri(
                        vscode.Uri.file(tempFilePath)
                    );
                    
                    // 发送文件URI到webview
                    webviewPanel.webview.postMessage({
                        command: 'setImageDataFromFile',
                        fileUri: tempFileUri.toString()
                    });
                    
                } catch (error) {
                    console.error('创建临时文件时出错:', error);
                    
                    // 如果二进制传输失败，回退到JSON方式
                    console.log('回退到JSON传输方式');
                    webviewPanel.webview.postMessage({
                        command: 'setImageData',
                        rawData: {
                            data: Array.from(hduData.data),
                            width: hduData.width,
                            height: hduData.height,
                            min: hduData.stats.min,
                            max: hduData.stats.max
                        }
                    });
                }
            }
            
        } catch (error) {
            console.error('处理FITS文件时出错:', error);
            webviewPanel.webview.postMessage({
                command: 'setImageData',
                rawData: null,
                message: `无法显示FITS图像: ${error instanceof Error ? error.message : String(error)}`
            });
            vscode.window.showErrorMessage(`无法打开FITS文件: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    private async getPixelValue(fileUri: vscode.Uri, x: number, y: number, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            const hduData = await this.dataManager.getHDUData(fileUri, 0);
            if (!hduData || hduData.type !== HDUType.IMAGE) {
                throw new Error('无法获取图像数据');
            }
            
            // 检查坐标是否在图像范围内
            if (!hduData.width || !hduData.height || x < 0 || x >= hduData.width || y < 0 || y >= hduData.height) {
                throw new Error('坐标超出图像范围');
            }
            
            // 获取像素值
            const index = y * hduData.width + x;
            const pixelValue = hduData.data[index];
            
            // 计算WCS坐标（如果有）
            let wcsValue = '-';
            const header = this.dataManager.getHDUHeader(fileUri, 0);
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
                    wcsValue = `RA: ${ra.toFixed(6)}°, Dec: ${dec.toFixed(6)}°`;
                }
            }
            
            // 发送像素信息到webview
            webviewPanel.webview.postMessage({
                command: 'setPixelInfo',
                x: x,
                y: y,
                value: pixelValue,
                wcs: wcsValue
            });
            
        } catch (error) {
            console.error('获取像素值时出错:', error);
            webviewPanel.webview.postMessage({
                command: 'setPixelInfo',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
    
    private async setScaleType(fileUri: vscode.Uri, scaleType: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            console.time('setScaleType');
            
            const hduData = await this.dataManager.getHDUData(fileUri, 0);
            if (!hduData || hduData.type !== HDUType.IMAGE) {
                throw new Error('无法获取图像数据');
            }
            
            // 创建临时文件
            const metadataBuffer = Buffer.from(JSON.stringify({
                width: hduData.width,
                height: hduData.height,
                min: hduData.stats.min,
                max: hduData.stats.max
            }));
            
            const headerLengthBuffer = Buffer.alloc(4);
            headerLengthBuffer.writeUInt32LE(metadataBuffer.length, 0);
            
            const dataBuffer = Buffer.from(hduData.data.buffer);
            
            const combinedBuffer = Buffer.concat([
                headerLengthBuffer,
                metadataBuffer,
                dataBuffer
            ]);
            
            const tempFilePath = await this.dataManager.createTempFile(fileUri, combinedBuffer);
            
            const tempFileUri = webviewPanel.webview.asWebviewUri(
                vscode.Uri.file(tempFilePath)
            );
            
            webviewPanel.webview.postMessage({
                command: 'setImageDataFromFile',
                fileUri: tempFileUri.toString()
            });
            
            console.timeEnd('setScaleType');
            
        } catch (error) {
            console.error('设置缩放类型时出错:', error);
            webviewPanel.webview.postMessage({
                command: 'setImageData',
                rawData: null,
                message: `无法应用缩放: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }
    
    private async sendHeaderInfo(fileUri: vscode.Uri, webviewPanel: vscode.WebviewPanel, hduIndex: number = 0): Promise<void> {
        try {
            const header = this.dataManager.getHDUHeader(fileUri, hduIndex);
            if (!header) {
                throw new Error('无法获取头信息');
            }
            
            const headerItems = header.getAllItems();
            let headerHtml = '<table style="width:100%">';
            for (const item of headerItems) {
                headerHtml += `<tr><td>${item.key}</td><td>${item.value}</td><td>${item.comment || ''}</td></tr>`;
            }
            headerHtml += '</table>';
            
            webviewPanel.webview.postMessage({
                command: 'setHeaderInfo',
                html: headerHtml
            });
            
        } catch (error) {
            console.error('发送头信息时出错:', error);
            webviewPanel.webview.postMessage({
                command: 'setHeaderInfo',
                html: `<p class="error">无法获取头信息: ${error instanceof Error ? error.message : String(error)}</p>`
            });
        }
    }
    
    private async switchHDU(fileUri: vscode.Uri, hduIndex: number, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const uriString = fileUri.toString();

        if (this.loadingManager.isLoading(uriString)) {
            webviewPanel.webview.postMessage({
                command: 'setImageData',
                rawData: null,
                message: 'HDU切换中，请稍候...'
            });
            return;
        }

        try {
            const hduData = await this.dataManager.getHDUData(fileUri, hduIndex);
            if (!hduData) {
                throw new Error(`无法获取HDU ${hduIndex} 的数据`);
            }
            
            await this.sendHeaderInfo(fileUri, webviewPanel, hduIndex);
            
            // 根据HDU类型处理数据
            if (hduData.type === HDUType.IMAGE) {
                try {
                    // 创建临时文件
                    const metadataBuffer = Buffer.from(JSON.stringify({
                        width: hduData.width,
                        height: hduData.height,
                        min: hduData.stats.min,
                        max: hduData.stats.max
                    }));
                    
                    const headerLengthBuffer = Buffer.alloc(4);
                    headerLengthBuffer.writeUInt32LE(metadataBuffer.length, 0);
                    
                    const dataBuffer = Buffer.from(hduData.data.buffer);
                    
                    const combinedBuffer = Buffer.concat([
                        headerLengthBuffer,
                        metadataBuffer,
                        dataBuffer
                    ]);
                    
                    const tempFilePath = await this.dataManager.createTempFile(fileUri, combinedBuffer);
                    
                    const tempFileUri = webviewPanel.webview.asWebviewUri(
                        vscode.Uri.file(tempFilePath)
                    );
                    
                    webviewPanel.webview.postMessage({
                        command: 'setImageDataFromFile',
                        fileUri: tempFileUri.toString()
                    });
                    
                } catch (error) {
                    console.error('创建临时文件时出错:', error);
                    webviewPanel.webview.postMessage({
                        command: 'setImageData',
                        rawData: {
                            data: Array.from(hduData.data),
                            width: hduData.width,
                            height: hduData.height,
                            min: hduData.stats.min,
                            max: hduData.stats.max
                        }
                    });
                }
            } else if (hduData.type === HDUType.BINTABLE || hduData.type === HDUType.TABLE) {
                webviewPanel.webview.postMessage({
                    command: 'showSpectrum',
                    data: Array.from(hduData.data),
                    wavelength: Array.from({ length: hduData.data.length }, (_, i) => i)
                });
            } else {
                // 对于未知类型，尝试根据维度判断
                const header = this.dataManager.getHDUHeader(fileUri, hduIndex);
                if (header) {
                    const naxis = header.getItem('NAXIS')?.value || 0;
                    const naxis1 = header.getItem('NAXIS1')?.value || 0;
                    const naxis2 = header.getItem('NAXIS2')?.value || 0;
                    
                    if (naxis === 1 || (naxis === 2 && (naxis1 === 1 || naxis2 === 1))) {
                        webviewPanel.webview.postMessage({
                            command: 'showSpectrum',
                            data: Array.from(hduData.data),
                            wavelength: Array.from({ length: hduData.data.length }, (_, i) => i)
                        });
                    } else {
                        webviewPanel.webview.postMessage({
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
            
        } catch (error) {
            console.error('切换HDU时出错:', error);
            webviewPanel.webview.postMessage({
                command: 'setImageData',
                rawData: null,
                message: `切换HDU失败: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }
} 