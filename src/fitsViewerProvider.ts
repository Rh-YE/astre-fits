import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FITSParser, FITS } from './fitsParser';
import * as crypto from 'crypto';
import { FITSDataManager, HDUType, ColumnData } from './models/FITSDataManager';
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
        try {
            // 验证文件是否存在
            await vscode.workspace.fs.stat(uri);
            console.log('文件存在，继续处理');
            return { uri, dispose: () => { } };
        } catch (error) {
            console.error(`打开文件失败: ${error}`);
            throw error;
        }
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
        console.log('开始加载FITS文件...');
        try {
            // 读取FITS文件
            console.log(`尝试读取文件: ${fileUri.fsPath}`);
            const fitsData = await fs.promises.readFile(fileUri.fsPath);
            console.log(`已读取FITS文件，大小: ${fitsData.length} 字节`);
            
            console.log('开始解析FITS数据...');
            const parser = new FITSParser();
            const fits = parser.parseFITS(new Uint8Array(fitsData));
            console.log('FITS数据解析完成');
            
            // 加载到数据管理器
            console.log('正在加载到数据管理器...');
            await this.dataManager.loadFITS(fileUri, fits);
            this.currentFileUri = fileUri;
            console.log('FITS文件加载完成');
            
            return fits;
        } catch (error) {
            console.error(`加载FITS文件失败: ${error}`);
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
            
            // 检查图像大小，如果超过阈值，则使用分块处理
            const isLargeImage = hduData.data.length > 4000000; // 约4百万像素的阈值
            console.log(`图像大小: ${hduData.data.length} 像素, 使用${isLargeImage ? '分块' : '标准'}处理`);
            
            // 创建变换后的数据数组
            const transformedData = new Float32Array(hduData.data.length);
            const min = hduData.stats.min;
            const max = hduData.stats.max;
            
            // 通知用户处理开始
            webviewPanel.webview.postMessage({
                command: 'processingStatus',
                status: 'start',
                message: `正在应用${scaleType}变换...`
            });
            
            // 定义批量处理函数
            const processDataChunk = (data: Float32Array, start: number, end: number, scaleType: string): void => {
                const chunkSize = end - start;
                const chunk = data.subarray(start, end);
                const resultChunk = transformedData.subarray(start, end);
                
                switch (scaleType) {
                    case 'linear':
                        // 线性变换 - 直接复制
                        resultChunk.set(chunk);
                        break;
                        
                    case 'log':
                        // 对数变换 - 使用批量操作
                        const offset = min <= 0 ? -min + 1 : 0;
                        if (offset === 0) {
                            // 如果没有偏移，可以直接使用Math.log
                            for (let i = 0; i < chunkSize; i++) {
                                resultChunk[i] = Math.log(chunk[i]);
                            }
                        } else {
                            // 有偏移时，需要先加上偏移
                            for (let i = 0; i < chunkSize; i++) {
                                resultChunk[i] = Math.log(chunk[i] + offset);
                            }
                        }
                        break;
                        
                    case 'sqrt':
                        // 平方根变换
                        const sqrtOffset = min < 0 ? -min : 0;
                        if (sqrtOffset === 0) {
                            for (let i = 0; i < chunkSize; i++) {
                                resultChunk[i] = Math.sqrt(chunk[i]);
                            }
                        } else {
                            for (let i = 0; i < chunkSize; i++) {
                                resultChunk[i] = Math.sqrt(chunk[i] + sqrtOffset);
                            }
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
                            resultChunk[i] = Math.asinh(chunk[i]);
                        }
                        break;
                        
                    case 'sinh':
                        // 双曲正弦变换
                        for (let i = 0; i < chunkSize; i++) {
                            resultChunk[i] = Math.sinh(chunk[i]);
                        }
                        break;
                        
                    case 'power':
                        // 幂律变换 (gamma = 2.0)
                        const powerOffset = min < 0 ? -min : 0;
                        const powerScale = 1.0 / (max + powerOffset);
                        for (let i = 0; i < chunkSize; i++) {
                            const normalizedValue = (chunk[i] + powerOffset) * powerScale;
                            resultChunk[i] = Math.pow(normalizedValue, 2.0);
                        }
                        break;
                        
                    case 'histogram':
                        // 直方图均衡化 - 这个需要全局处理，不适合分块
                        // 在外部处理
                        break;
                        
                    case 'zscale':
                        // z-scale 算法 - 这个也需要全局处理
                        // 在外部处理
                        break;
                        
                    default:
                        resultChunk.set(chunk);
                        break;
                }
            };
            
            // 特殊处理需要全局数据的变换
            if (scaleType === 'histogram') {
                // 直方图均衡化
                const histSize = 256;
                const hist = new Uint32Array(histSize);
                const cdf = new Uint32Array(histSize);
                
                // 计算直方图 - 使用整个数据集
                const histScale = histSize / (max - min);
                for (let i = 0; i < hduData.data.length; i++) {
                    const bin = Math.floor((hduData.data[i] - min) * histScale);
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
                const chunkSize = isLargeImage ? 1000000 : hduData.data.length;
                for (let start = 0; start < hduData.data.length; start += chunkSize) {
                    const end = Math.min(start + chunkSize, hduData.data.length);
                    
                    for (let i = start; i < end; i++) {
                        const bin = Math.floor((hduData.data[i] - min) * histScale);
                        if (bin >= 0 && bin < histSize) {
                            transformedData[i] = (cdf[bin] - cdfMin) * cdfScale;
                        }
                    }
                    
                    // 更新进度
                    if (isLargeImage) {
                        const progress = Math.round((end / hduData.data.length) * 100);
                        webviewPanel.webview.postMessage({
                            command: 'processingStatus',
                            status: 'progress',
                            progress: progress,
                            message: `直方图均衡化处理中: ${progress}%`
                        });
                        
                        // 给UI线程一些时间更新
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
            } else if (scaleType === 'zscale') {
                // z-scale 算法 (简化版本)
                const sampleSize = Math.min(10000, hduData.data.length);
                const sample = new Float32Array(sampleSize);
                const step = Math.max(1, Math.floor(hduData.data.length / sampleSize));
                
                // 采样数据
                for (let i = 0, j = 0; i < hduData.data.length && j < sampleSize; i += step, j++) {
                    sample[j] = hduData.data[i];
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
                
                // 应用 z-scale 变换
                const zLow = median - 2.5 * stdDev;
                const zHigh = median + 2.5 * stdDev;
                const zScale = 1.0 / (zHigh - zLow || 1); // 避免除以零
                
                // 分块处理
                const chunkSize = isLargeImage ? 1000000 : hduData.data.length;
                for (let start = 0; start < hduData.data.length; start += chunkSize) {
                    const end = Math.min(start + chunkSize, hduData.data.length);
                    
                    for (let i = start; i < end; i++) {
                        transformedData[i] = Math.max(0, Math.min(1, (hduData.data[i] - zLow) * zScale));
                    }
                    
                    // 更新进度
                    if (isLargeImage) {
                        const progress = Math.round((end / hduData.data.length) * 100);
                        webviewPanel.webview.postMessage({
                            command: 'processingStatus',
                            status: 'progress',
                            progress: progress,
                            message: `Z-Scale处理中: ${progress}%`
                        });
                        
                        // 给UI线程一些时间更新
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
            } else {
                // 对于其他变换，使用分块处理
                const chunkSize = isLargeImage ? 1000000 : hduData.data.length;
                for (let start = 0; start < hduData.data.length; start += chunkSize) {
                    const end = Math.min(start + chunkSize, hduData.data.length);
                    
                    processDataChunk(hduData.data, start, end, scaleType);
                    
                    // 更新进度
                    if (isLargeImage) {
                        const progress = Math.round((end / hduData.data.length) * 100);
                        webviewPanel.webview.postMessage({
                            command: 'processingStatus',
                            status: 'progress',
                            progress: progress,
                            message: `${scaleType}变换处理中: ${progress}%`
                        });
                        
                        // 给UI线程一些时间更新
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
            }
            
            // 计算变换后的数据范围
            let newMin = Number.POSITIVE_INFINITY;
            let newMax = Number.NEGATIVE_INFINITY;
            
            // 分块计算最小值和最大值
            const statsChunkSize = 1000000; // 每次处理100万个元素
            for (let start = 0; start < transformedData.length; start += statsChunkSize) {
                const end = Math.min(start + statsChunkSize, transformedData.length);
                
                for (let i = start; i < end; i++) {
                    if (isFinite(transformedData[i])) {
                        newMin = Math.min(newMin, transformedData[i]);
                        newMax = Math.max(newMax, transformedData[i]);
                    }
                }
            }
            
            // 创建临时文件
            const metadataBuffer = Buffer.from(JSON.stringify({
                width: hduData.width,
                height: hduData.height,
                min: newMin,
                max: newMax,
                scaleType: scaleType
            }));
            
            const headerLengthBuffer = Buffer.alloc(4);
            headerLengthBuffer.writeUInt32LE(metadataBuffer.length, 0);
            
            const dataBuffer = Buffer.from(transformedData.buffer);
            
            const combinedBuffer = Buffer.concat([
                headerLengthBuffer,
                metadataBuffer,
                dataBuffer
            ]);
            
            // 通知用户处理完成
            webviewPanel.webview.postMessage({
                command: 'processingStatus',
                status: 'complete',
                message: '变换处理完成，正在准备图像...'
            });
            
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
                // 处理光谱数据
                if (hduData.columns) {
                    console.log('发现列数据，开始处理光谱...');
                    console.log('可用列:', Array.from(hduData.columns.keys()));
                    
                    // 查找波长和流量列（不区分大小写）
                    let wavelengthData: number[] | undefined;
                    let fluxData: number[] | undefined;
                    let wavelengthUnit: string | undefined;
                    let fluxUnit: string | undefined;

                    for (const [name, column] of hduData.columns) {
                        const columnNameLower = name.toLowerCase();
                        console.log(`处理列: ${name}, 数据类型: ${column.dataType}, 单位: ${column.unit || '无'}`);
                        
                        if (columnNameLower.includes('wavelength') || columnNameLower === 'wave' || columnNameLower === 'lambda') {
                            console.log(`找到波长列: ${name}`);
                            wavelengthData = Array.from(column.data);
                            wavelengthUnit = column.unit;
                        } else if (columnNameLower.includes('flux') || columnNameLower === 'data' || columnNameLower === 'intensity') {
                            console.log(`找到流量列: ${name}`);
                            fluxData = Array.from(column.data);
                            fluxUnit = column.unit;
                        }
                    }

                    // 如果没有找到波长列，则创建一个序号数组
                    if (!wavelengthData && fluxData) {
                        console.log('未找到波长列，使用像素索引');
                        wavelengthData = Array.from({ length: fluxData.length }, (_, i) => i);
                        wavelengthUnit = 'pixel';
                    }
                    // 如果没有找到流量列，使用第一列数据
                    if (!fluxData && hduData.data) {
                        console.log('未找到流量列，使用第一列数据');
                        fluxData = Array.from(hduData.data);
                        if (!wavelengthData) {
                            wavelengthData = Array.from({ length: fluxData.length }, (_, i) => i);
                            wavelengthUnit = 'pixel';
                        }
                    }

                    // 发送光谱数据到webview
                    if (wavelengthData && fluxData) {
                        console.log('准备发送光谱数据到webview');
                        console.log(`波长数据长度: ${wavelengthData.length}, 单位: ${wavelengthUnit}`);
                        console.log(`流量数据长度: ${fluxData.length}, 单位: ${fluxUnit}`);
                        
                        // 输出前20个波长和流量值用于调试
                        console.log('波长数据前20个值:');
                        console.table(wavelengthData.slice(0, 20).map((value, index) => ({
                            index,
                            wavelength: value
                        })));

                        console.log('流量数据前20个值:');
                        console.table(fluxData.slice(0, 20).map((value, index) => ({
                            index,
                            flux: value
                        })));

                        webviewPanel.webview.postMessage({
                            command: 'showSpectrum',
                            data: {
                                wavelength: wavelengthData,
                                flux: fluxData,
                                wavelengthUnit: wavelengthUnit || 'Å',
                                fluxUnit: fluxUnit || 'Counts'
                            }
                        });
                        console.log('光谱数据已发送到webview');
                    } else {
                        console.log('未能找到有效的波长或流量数据');
                        webviewPanel.webview.postMessage({
                            command: 'setImageData',
                            rawData: null,
                            message: '无法显示光谱：未找到有效的波长或流量数据'
                        });
                    }
                } else {
                    console.log('未找到列数据');
                    webviewPanel.webview.postMessage({
                        command: 'setImageData',
                        rawData: null,
                        message: '无法显示光谱：未找到列数据'
                    });
                }
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

    // 获取列的单位
    private getColumnUnit(columns: Map<string, ColumnData>, columnType: string): string | undefined {
        for (const [name, column] of columns) {
            if (name.toLowerCase().includes(columnType.toLowerCase())) {
                return column.unit;
            }
        }
        return undefined;
    }
} 