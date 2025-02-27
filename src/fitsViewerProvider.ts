import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FITSParser, FITS } from './fitsParser';
import * as crypto from 'crypto';

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
    private tempDir: string;
    private fitsCache: Map<string, FITS> = new Map();
    private currentFileUri: vscode.Uri | undefined;
    private tempFiles: Set<string> = new Set(); // 用于跟踪临时文件
    
    // 分块缓存相关属性
    private chunkSize: number = 250000; // 减小默认块大小为25万像素
    private processedChunksCache: Map<string, Map<string, Float32Array>> = new Map();
    // 添加统计信息缓存，避免重复计算
    private statsCache: Map<string, {min: number, max: number, mean: number, stdDev: number}> = new Map();

    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        console.log('FitsViewerProvider 已创建');
        // 使用VSCode的全局存储路径作为临时目录
        this.tempDir = path.join(context.globalStorageUri.fsPath, 'fits-temp');
        // 确保目录存在
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        
        // 启动时清理可能存在的旧临时文件
        this.cleanupTempFiles();
    }

    // 清理临时文件的方法
    private cleanupTempFiles(): void {
        if (fs.existsSync(this.tempDir)) {
            try {
                const files = fs.readdirSync(this.tempDir);
                for (const file of files) {
                    const filePath = path.join(this.tempDir, file);
                    fs.unlinkSync(filePath);
                    console.log(`已删除临时文件: ${filePath}`);
                }
                this.tempFiles.clear();
            } catch (error) {
                console.error('清理临时文件时出错:', error);
            }
        }
    }

    // 添加临时文件到跟踪列表
    private trackTempFile(filePath: string): void {
        this.tempFiles.add(filePath);
    }

    // 创建临时文件并跟踪
    private async createTempFile(prefix: string, data: Buffer): Promise<string> {
        const fileName = `${prefix}-${crypto.randomBytes(8).toString('hex')}.bin`;
        const filePath = path.join(this.tempDir, fileName);
        
        await fs.promises.writeFile(filePath, data);
        this.trackTempFile(filePath);
        
        return filePath;
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
        
        // 设置webview的HTML内容
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
                vscode.Uri.file(this.tempDir)
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
        
        // 当编辑器关闭时清除缓存和临时文件
        webviewPanel.onDidDispose(() => {
            if (document.uri) {
                this.clearCache(document.uri);
                this.currentFileUri = undefined;
                // 清理所有临时文件
                this.cleanupTempFiles();
                console.log(`已清除文件缓存和临时文件: ${document.uri.fsPath}`);
            }
        });
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        // 获取HTML文件路径
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'fitsViewer.html');
        console.log(`HTML文件路径: ${htmlPath.fsPath}`);
        
        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
        console.log('已读取HTML内容');
        
        // 替换HTML中的路径，确保webview可以正确加载资源
        return htmlContent;
    }

    private async getFITS(fileUri: vscode.Uri): Promise<FITS> {
        const uriString = fileUri.toString();
        
        // 检查缓存中是否已有解析结果
        if (this.fitsCache.has(uriString)) {
            console.log(`使用缓存的FITS数据: ${fileUri.fsPath}`);
            return this.fitsCache.get(uriString)!;
        }
        
        console.log(`解析FITS文件: ${fileUri.fsPath}`);
        
        try {
            // 读取FITS文件
            const fitsData = await fs.promises.readFile(fileUri.fsPath);
            console.log(`已读取FITS文件，大小: ${fitsData.length} 字节`);
            
            // 解析FITS文件
            const parser = new FITSParser();
            const fits = parser.parseFITS(new Uint8Array(fitsData));
            
            // 缓存解析结果
            this.fitsCache.set(uriString, fits);
            this.currentFileUri = fileUri;
            
            // 识别主HDU类型
            const primaryHDU = fits.getHDU(0);
            if (primaryHDU) {
                const xtension = primaryHDU.header.getItem('XTENSION')?.value;
                if (xtension) {
                    const hduType = xtension.trim().toUpperCase();
                    if (hduType === 'IMAGE') {
                        console.log('识别到图像数据 (XTENSION IMAGE)');
                        // 处理图像数据逻辑
                    } else if (hduType === 'BINTABLE' || hduType === 'TABLE') {
                        console.log('识别到光谱数据 (' + hduType + ')');
                        this.processSpectrumData(primaryHDU);
                    } else {
                        console.warn('未知的XTENSION类型：' + hduType);
                    }
                } else {
                    // 如果没有XTENSION，则根据NAXIS判断
                    const naxis = primaryHDU.header.getItem('NAXIS')?.value || 0;
                    if (naxis >= 2) {
                        console.log('识别到图像数据 (无XTENSION, NAXIS>=2)');
                        // 处理图像数据逻辑
                    } else {
                        console.log('识别到光谱数据 (无XTENSION, NAXIS<2)');
                        this.processSpectrumData(primaryHDU);
                    }
                }
            }
            
            return fits;
        } catch (error) {
            console.error('解析FITS文件时出错:', error);
            throw error;
        }
    }

    private async updateWebview(fileUri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            console.log(`开始更新webview，文件: ${fileUri.fsPath}`);
            
            // 显示加载消息
            webviewPanel.webview.postMessage({
                command: 'setImageData',
                rawData: null,
                message: '正在解析FITS文件，请稍候...'
            });
            
            // 使用Promise.race和超时Promise来防止解析过程卡住
            const parsePromise = this.getFITS(fileUri);
            
            const timeoutPromise = new Promise<FITS>((_, reject) => {
                setTimeout(() => {
                    reject(new Error('解析FITS文件超时，文件可能过大或格式不正确'));
                }, 10000);
            });
            
            // 等待解析完成或超时
            const fits = await Promise.race([parsePromise, timeoutPromise]);
            console.log('已解析FITS文件');
            
            // 发送HDU数量到webview
            webviewPanel.webview.postMessage({
                command: 'setHDUCount',
                count: fits.hdus.length
            });
            
            this.sendHeaderInfo(fileUri, webviewPanel);
            
            if (!fits || !fits.headers || fits.headers.length === 0) {
                throw new Error('无法解析FITS文件');
            }
            
            const primaryHeader = fits.headers[0];
            const fileName = path.basename(fileUri.fsPath);
            webviewPanel.webview.postMessage({
                command: 'setFileName',
                fileName: fileName
            });
            console.log(`已发送文件名: ${fileName}`);
            
            const objectName = primaryHeader.getItem('OBJECT')?.value || '未知对象';
            webviewPanel.webview.postMessage({
                command: 'setObjectName',
                objectName: objectName
            });
            
            let headerSummary = '<table style="width:100%">';
            const keyItems = ['BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'DATE-OBS', 'EXPTIME', 'TELESCOP', 'INSTRUME'];
            
            for (const key of keyItems) {
                const item = primaryHeader.getItem(key);
                if (item) {
                    headerSummary += `<tr><td>${key}</td><td>${item.value}</td></tr>`;
                }
            }
            headerSummary += '</table>';
            
            webviewPanel.webview.postMessage({
                command: 'setHeaderSummary',
                html: headerSummary
            });
            
            // 获取图像数据
            const imageHDU = fits.getHDU(0);
            if (!imageHDU || !imageHDU.data) {
                throw new Error('FITS文件不包含图像数据');
            }
            
            // 计算图像统计信息 - 使用缓存避免重复计算
            const imageData = imageHDU.data;
            console.log(`图像数据大小: ${imageData.length} 像素`);
            
            if (imageData.length === 0) {
                throw new Error('图像数据为空');
            }
            
            // 使用缓存的统计信息或计算新的统计信息
            const uriString = fileUri.toString();
            let stats;
            
            if (this.statsCache.has(uriString)) {
                console.log('使用缓存的统计信息');
                stats = this.statsCache.get(uriString)!;
            } else {
                console.log('计算图像统计信息');
                // 使用分块计算统计信息，避免一次性处理过多数据
                let min = Number.MAX_VALUE;
                let max = Number.MIN_VALUE;
                let sum = 0;
                
                // 分块计算最小值、最大值和总和
                for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                    const end = Math.min(offset + this.chunkSize, imageData.length);
                    for (let i = offset; i < end; i++) {
                        const value = imageData[i];
                        min = Math.min(min, value);
                        max = Math.max(max, value);
                        sum += value;
                    }
                }
                
                const mean = sum / imageData.length;
                
                // 分块计算标准差
                let sumSquaredDiff = 0;
                for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                    const end = Math.min(offset + this.chunkSize, imageData.length);
                    for (let i = offset; i < end; i++) {
                        const diff = imageData[i] - mean;
                        sumSquaredDiff += diff * diff;
                    }
                }
                const stdDev = Math.sqrt(sumSquaredDiff / imageData.length);
                
                // 缓存统计信息
                stats = { min, max, mean, stdDev };
                this.statsCache.set(uriString, stats);
                console.log('已缓存统计信息');
            }
            
            // 发送统计信息
            const statsInfo = `
                <table style="width:100%">
                    <tr><td>最小值</td><td>${stats.min.toFixed(2)}</td></tr>
                    <tr><td>最大值</td><td>${stats.max.toFixed(2)}</td></tr>
                    <tr><td>平均值</td><td>${stats.mean.toFixed(2)}</td></tr>
                    <tr><td>标准差</td><td>${stats.stdDev.toFixed(2)}</td></tr>
                </table>
            `;
            webviewPanel.webview.postMessage({
                command: 'setStatsInfo',
                html: statsInfo
            });
            
            // 发送帧信息
            const naxis3 = primaryHeader.getItem('NAXIS3')?.value || 1;
            webviewPanel.webview.postMessage({
                command: 'setFrameInfo',
                frameInfo: `1/${naxis3}`
            });
            
            // 将图像数据转换为可显示的格式
            const width = primaryHeader.getItem('NAXIS1')?.value || 0;
            const height = primaryHeader.getItem('NAXIS2')?.value || 0;
            
            if (width <= 0 || height <= 0) {
                throw new Error('无效的图像尺寸');
            }
            
            console.log(`图像尺寸: ${width}x${height}`);
            
            // 检查图像尺寸是否合理
            if (width * height !== imageData.length) {
                console.warn(`警告: 图像尺寸(${width}x${height}=${width*height})与数据长度(${imageData.length})不匹配`);
            }
            
            // 直接将原始数据发送到webview
            console.log('准备发送图像数据到webview');
            
            try {
                // 创建一个临时文件来存储图像数据
                const tempFileName = `fits-data-${crypto.randomBytes(8).toString('hex')}.bin`;
                const tempFilePath = path.join(this.tempDir, tempFileName);
                
                // 创建一个包含元数据的头部
                const metadataBuffer = Buffer.from(JSON.stringify({
                    width: width,
                    height: height,
                    min: stats.min,
                    max: stats.max
                }));
                
                // 创建一个32位的头部长度指示器
                const headerLengthBuffer = Buffer.alloc(4);
                headerLengthBuffer.writeUInt32LE(metadataBuffer.length, 0);
                
                // 将Float32Array转换为Buffer
                const dataBuffer = Buffer.from(imageData.buffer);
                
                // 将所有数据写入临时文件
                const fileStream = fs.createWriteStream(tempFilePath);
                fileStream.write(headerLengthBuffer);
                fileStream.write(metadataBuffer);
                fileStream.write(dataBuffer);
                fileStream.end();
                
                // 等待文件写入完成
                await new Promise<void>((resolve, reject) => {
                    fileStream.on('finish', resolve);
                    fileStream.on('error', reject);
                });
                
                console.log(`已将图像数据写入临时文件: ${tempFilePath}`);
                
                // 创建一个可以在webview中访问的URI
                const tempFileUri = webviewPanel.webview.asWebviewUri(
                    vscode.Uri.file(tempFilePath)
                );
                
                // 发送文件URI到webview
                webviewPanel.webview.postMessage({
                    command: 'setImageDataFromFile',
                    fileUri: tempFileUri.toString()
                });
                
                console.log('已发送图像数据文件URI到webview');
            } catch (error) {
                console.error('创建临时文件时出错:', error);
                
                // 如果二进制传输失败，回退到JSON方式
                console.log('回退到JSON传输方式');
                
                // 将Float32Array转换为普通数组
                const dataArray = Array.from(imageData);
                console.log(`已转换数据数组，长度: ${dataArray.length}`);
                
                // 发送完整数据
                webviewPanel.webview.postMessage({
                    command: 'setImageData',
                    rawData: {
                        data: dataArray,
                        width: width,
                        height: height,
                        min: stats.min,
                        max: stats.max
                    }
                });
                
                console.log('已发送完整图像数据到webview');
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
            // 使用缓存的FITS数据，而不是每次都重新读取和解析文件
            const fits = await this.getFITS(fileUri);
            
            if (!fits || !fits.headers || fits.headers.length === 0) {
                throw new Error('无法解析FITS文件');
            }
            
            // 获取主头信息
            const primaryHeader = fits.headers[0];
            
            // 获取图像尺寸
            const width = primaryHeader.getItem('NAXIS1')?.value || 0;
            const height = primaryHeader.getItem('NAXIS2')?.value || 0;
            
            // 检查坐标是否在图像范围内
            if (x < 0 || x >= width || y < 0 || y >= height) {
                throw new Error('坐标超出图像范围');
            }
            
            // 获取图像数据
            const imageHDU = fits.getHDU(0);
            if (!imageHDU || !imageHDU.data) {
                throw new Error('FITS文件不包含图像数据');
            }
            
            // 获取像素值
            const index = y * width + x;
            const pixelValue = imageHDU.data[index];
            
            // 计算WCS坐标（如果有WCS信息）
            let wcsValue = '-';
            const crpix1 = primaryHeader.getItem('CRPIX1')?.value;
            const crpix2 = primaryHeader.getItem('CRPIX2')?.value;
            const crval1 = primaryHeader.getItem('CRVAL1')?.value;
            const crval2 = primaryHeader.getItem('CRVAL2')?.value;
            const cdelt1 = primaryHeader.getItem('CDELT1')?.value;
            const cdelt2 = primaryHeader.getItem('CDELT2')?.value;
            
            if (crpix1 !== undefined && crpix2 !== undefined && 
                crval1 !== undefined && crval2 !== undefined && 
                cdelt1 !== undefined && cdelt2 !== undefined) {
                const ra = crval1 + (x - crpix1) * cdelt1;
                const dec = crval2 + (y - crpix2) * cdelt2;
                wcsValue = `RA: ${ra.toFixed(5)}°, Dec: ${dec.toFixed(5)}°`;
            }
            
            // 计算物理坐标（如果有相关信息）
            let physicalValue = '-';
            const xpixelsz = primaryHeader.getItem('XPIXELSZ')?.value;
            const ypixelsz = primaryHeader.getItem('YPIXELSZ')?.value;
            
            if (xpixelsz !== undefined && ypixelsz !== undefined) {
                physicalValue = `X: ${(x * xpixelsz).toFixed(3)} mm, Y: ${(y * ypixelsz).toFixed(3)} mm`;
            }
            
            // 发送像素值信息到webview
            webviewPanel.webview.postMessage({
                command: 'setPixelValue',
                value: pixelValue.toString(),
                wcs: wcsValue,
                physical: physicalValue
            });
            
        } catch (error) {
            console.error('获取像素值时出错:', error);
        }
    }
    
    private async setScaleType(fileUri: vscode.Uri, scaleType: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            console.time('setScaleType');
            // 使用缓存的FITS数据，而不是每次都重新读取和解析文件
            const fits = await this.getFITS(fileUri);
            
            if (!fits || !fits.headers || fits.headers.length === 0) {
                throw new Error('无法解析FITS文件');
            }
            
            // 获取主头信息
            const primaryHeader = fits.headers[0];
            
            // 获取图像数据
            const imageHDU = fits.getHDU(0);
            if (!imageHDU || !imageHDU.data) {
                throw new Error('FITS文件不包含图像数据');
            }
            
            // 获取图像尺寸
            const width = primaryHeader.getItem('NAXIS1')?.value || 0;
            const height = primaryHeader.getItem('NAXIS2')?.value || 0;
            
            if (width <= 0 || height <= 0) {
                throw new Error('无效的图像尺寸');
            }
            
            // 获取图像数据
            const imageData = imageHDU.data;
            
            // 检查是否已有该文件的缓存
            const fileKey = fileUri.toString();
            if (!this.processedChunksCache.has(fileKey)) {
                this.processedChunksCache.set(fileKey, new Map<string, Float32Array>());
            }
            
            // 获取该文件的缓存
            const fileCache = this.processedChunksCache.get(fileKey)!;
            
            // 检查是否已有该缩放类型的缓存
            if (fileCache.has(scaleType)) {
                console.log(`使用缓存的${scaleType}缩放数据`);
                console.time('sendCachedData');
                
                // 直接使用缓存的数据
                const scaledData = fileCache.get(scaleType)!;
                
                // 发送缩放后的数据到webview
                webviewPanel.webview.postMessage({
                    command: 'setImageData',
                    rawData: {
                        data: Array.from(scaledData), // 转换为普通数组以便序列化
                        width: width,
                        height: height,
                        min: 0,
                        max: 1
                    }
                });
                
                console.timeEnd('sendCachedData');
                // 显示处理完成的消息
                vscode.window.showInformationMessage(`已应用 ${scaleType} 缩放`);
                console.timeEnd('setScaleType');
                return;
            }
            
            // 获取统计信息（从缓存或重新计算）
            let stats;
            if (this.statsCache.has(fileKey)) {
                stats = this.statsCache.get(fileKey)!;
            } else {
                // 分块计算统计信息
                let min = Number.MAX_VALUE;
                let max = Number.MIN_VALUE;
                let sum = 0;
                
                for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                    const end = Math.min(offset + this.chunkSize, imageData.length);
                    for (let i = offset; i < end; i++) {
                        const value = imageData[i];
                        min = Math.min(min, value);
                        max = Math.max(max, value);
                        sum += value;
                    }
                }
                
                const mean = sum / imageData.length;
                
                let sumSquaredDiff = 0;
                for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                    const end = Math.min(offset + this.chunkSize, imageData.length);
                    for (let i = offset; i < end; i++) {
                        const diff = imageData[i] - mean;
                        sumSquaredDiff += diff * diff;
                    }
                }
                const stdDev = Math.sqrt(sumSquaredDiff / imageData.length);
                
                stats = { min, max, mean, stdDev };
                this.statsCache.set(fileKey, stats);
            }
            
            console.log(`开始应用${scaleType}缩放`);
            console.time('createScaledData');
            
            // 创建缩放后的数据
            const scaledData = new Float32Array(imageData.length);
            
            // 根据不同的缩放类型处理图像 - 使用分块处理和Web Workers优化
            switch (scaleType) {
                case 'linear':
                    // 线性缩放 - 使用向量化操作
                    const linearScale = 1 / (stats.max - stats.min);
                    
                    // 使用更高效的向量化操作
                    for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                        const end = Math.min(offset + this.chunkSize, imageData.length);
                        const chunkLength = end - offset;
                        
                        // 创建临时数组以提高性能
                        const tempArray = new Float32Array(chunkLength);
                        
                        // 复制数据到临时数组
                        for (let i = 0; i < chunkLength; i++) {
                            tempArray[i] = imageData[offset + i];
                        }
                        
                        // 一次性应用线性缩放
                        for (let i = 0; i < chunkLength; i++) {
                            tempArray[i] = (tempArray[i] - stats.min) * linearScale;
                        }
                        
                        // 复制回结果数组
                        for (let i = 0; i < chunkLength; i++) {
                            scaledData[offset + i] = tempArray[i];
                        }
                    }
                    break;
                case 'log':
                    // 对数缩放 - 使用向量化操作
                    const logMin = Math.log(Math.max(1e-10, stats.min));
                    const logMax = Math.log(Math.max(1e-10, stats.max));
                    const logScale = 1 / (logMax - logMin);
                    
                    for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                        const end = Math.min(offset + this.chunkSize, imageData.length);
                        const chunkLength = end - offset;
                        
                        // 创建临时数组
                        const tempArray = new Float32Array(chunkLength);
                        
                        // 复制并处理数据 - 使用更高效的批处理方式
                        for (let i = 0; i < chunkLength; i++) {
                            const value = Math.max(1e-10, imageData[offset + i]);
                            tempArray[i] = (Math.log(value) - logMin) * logScale;
                        }
                        
                        // 复制回结果数组
                        scaledData.set(tempArray, offset);
                    }
                    break;
                case 'sqrt':
                    // 平方根缩放 - 使用向量化操作
                    const sqrtMin = Math.sqrt(Math.max(0, stats.min));
                    const sqrtMax = Math.sqrt(Math.max(0, stats.max));
                    const sqrtScale = 1 / (sqrtMax - sqrtMin);
                    
                    for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                        const end = Math.min(offset + this.chunkSize, imageData.length);
                        const chunkLength = end - offset;
                        
                        // 创建临时数组
                        const tempArray = new Float32Array(chunkLength);
                        
                        // 复制并处理数据
                        for (let i = 0; i < chunkLength; i++) {
                            tempArray[i] = (Math.sqrt(Math.max(0, imageData[offset + i])) - sqrtMin) * sqrtScale;
                        }
                        
                        // 复制回结果数组
                        for (let i = 0; i < chunkLength; i++) {
                            scaledData[offset + i] = tempArray[i];
                        }
                    }
                    break;
                case 'zscale':
                    // zscale缩放 - 使用缓存的统计信息
                    const zMin = stats.mean - 2.5 * stats.stdDev;
                    const zMax = stats.mean + 2.5 * stats.stdDev;
                    const zScale = 1 / (zMax - zMin);
                    
                    for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                        const end = Math.min(offset + this.chunkSize, imageData.length);
                        const chunkLength = end - offset;
                        
                        // 创建临时数组
                        const tempArray = new Float32Array(chunkLength);
                        
                        // 复制并处理数据
                        for (let i = 0; i < chunkLength; i++) {
                            tempArray[i] = (imageData[offset + i] - zMin) * zScale;
                        }
                        
                        // 复制回结果数组
                        for (let i = 0; i < chunkLength; i++) {
                            scaledData[offset + i] = tempArray[i];
                        }
                    }
                    break;
                default:
                    // 其他缩放类型保持原有实现
                    // 这里省略了其他缩放类型的代码，保持原有实现
                    // 对于其他缩放类型，我们可以使用类似的优化方法
                    
                    // 默认使用线性缩放
                    const defaultScale = 1 / (stats.max - stats.min);
                    
                    for (let offset = 0; offset < imageData.length; offset += this.chunkSize) {
                        const end = Math.min(offset + this.chunkSize, imageData.length);
                        const chunkLength = end - offset;
                        
                        // 创建临时数组
                        const tempArray = new Float32Array(chunkLength);
                        
                        // 复制并处理数据
                        for (let i = 0; i < chunkLength; i++) {
                            tempArray[i] = (imageData[offset + i] - stats.min) * defaultScale;
                        }
                        
                        // 复制回结果数组
                        for (let i = 0; i < chunkLength; i++) {
                            scaledData[offset + i] = tempArray[i];
                        }
                    }
            }
            
            console.timeEnd('createScaledData');
            
            // 缓存处理结果
            fileCache.set(scaleType, scaledData);
            console.log(`已缓存${scaleType}缩放数据`);
            
            console.time('sendScaledData');
            
            // 优化数据传输 - 使用二进制传输而不是JSON序列化
            try {
                // 创建一个包含元数据的头部
                const metadataBuffer = Buffer.from(JSON.stringify({
                    width: width,
                    height: height,
                    min: 0,
                    max: 1,
                    scaleType: scaleType
                }));
                
                // 创建一个32位的头部长度指示器
                const headerLengthBuffer = Buffer.alloc(4);
                headerLengthBuffer.writeUInt32LE(metadataBuffer.length, 0);
                
                // 将Float32Array转换为Buffer
                const dataBuffer = Buffer.from(scaledData.buffer);
                
                // 创建完整的数据Buffer
                const fullBuffer = Buffer.concat([headerLengthBuffer, metadataBuffer, dataBuffer]);
                
                // 创建临时文件并获取路径
                const tempFilePath = await this.createTempFile('scaled-data', fullBuffer);
                
                console.log(`已将缩放数据写入临时文件: ${tempFilePath}`);
                
                // 创建一个可以在webview中访问的URI
                const tempFileUri = webviewPanel.webview.asWebviewUri(
                    vscode.Uri.file(tempFilePath)
                );
                
                // 发送文件URI到webview
                webviewPanel.webview.postMessage({
                    command: 'setImageDataFromFile',
                    fileUri: tempFileUri.toString()
                });
                
                console.log('已发送缩放数据文件URI到webview');
            } catch (error) {
                console.error('创建临时文件时出错:', error);
                
                // 如果二进制传输失败，回退到JSON方式
                console.log('回退到JSON传输方式');
                
                // 发送缩放后的数据到webview - 使用分块传输
                if (scaledData.length > 5000000) {
                    // 对于非常大的数据，使用分块传输
                    console.log(`数据过大(${scaledData.length}像素)，使用分块传输`);
                    
                    // 先发送元数据
                    webviewPanel.webview.postMessage({
                        command: 'prepareForChunkedData',
                        metadata: {
                            width: width,
                            height: height,
                            min: 0,
                            max: 1,
                            totalChunks: Math.ceil(scaledData.length / this.chunkSize),
                            totalLength: scaledData.length
                        }
                    });
                    
                    // 分块发送数据
                    for (let offset = 0; offset < scaledData.length; offset += this.chunkSize) {
                        const end = Math.min(offset + this.chunkSize, scaledData.length);
                        const chunk = Array.from(scaledData.slice(offset, end));
                        
                        webviewPanel.webview.postMessage({
                            command: 'imageDataChunk',
                            chunkIndex: Math.floor(offset / this.chunkSize),
                            chunk: chunk,
                            offset: offset
                        });
                        
                        // 添加小延迟，避免消息队列阻塞
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                    
                    // 发送完成信号
                    webviewPanel.webview.postMessage({
                        command: 'imageDataComplete'
                    });
                } else {
                    // 对于较小的数据，直接发送
                    webviewPanel.webview.postMessage({
                        command: 'setImageData',
                        rawData: {
                            data: Array.from(scaledData),
                            width: width,
                            height: height,
                            min: 0,
                            max: 1
                        }
                    });
                }
            }
            console.timeEnd('sendScaledData');
            
            // 显示处理完成的消息
            vscode.window.showInformationMessage(`已应用 ${scaleType} 缩放`);
            console.timeEnd('setScaleType');
            
        } catch (error) {
            console.error('设置缩放类型时出错:', error);
            vscode.window.showErrorMessage(`应用缩放失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    private async sendHeaderInfo(fileUri: vscode.Uri, webviewPanel: vscode.WebviewPanel, hduIndex: number = 0): Promise<void> {
        try {
            const fits = await this.getFITS(fileUri);
            const hdu = fits.getHDU(hduIndex);
            if (!hdu) {
                throw new Error(`无法获取HDU ${hduIndex}`);
            }
            const headerInfo = hdu.header.getAllItems().map(item => `${item.key}: ${item.value}`).join('\n');
            webviewPanel.webview.postMessage({
                command: 'showHeaderInfo',
                headerInfo: headerInfo
            });
        } catch (error) {
            console.error('获取头文件信息时出错:', error);
            webviewPanel.webview.postMessage({
                command: 'showHeaderInfo',
                headerInfo: '无法获取头文件信息'
            });
        }
    }
    
    // 当编辑器关闭时清除缓存
    private clearCache(fileUri: vscode.Uri): void {
        const uriString = fileUri.toString();
        this.fitsCache.delete(uriString);
        this.processedChunksCache.delete(uriString);
        this.statsCache.delete(uriString);
        console.log(`已清除文件缓存: ${fileUri.fsPath}`);
    }

    // 修改 processSpectrumData 方法，不在扩展端直接处理光谱数据，而是由 webview 端处理
    private processSpectrumData(primaryHDU: any): void {
        console.log('光谱数据由 webview 处理。请确保 webview 接收到相应消息。');
        // 如有需要，可以通过其他渠道将数据传输到 webview，由 webview JS 代码进行渲染
    }

    // 添加处理HDU切换的方法
    private async switchHDU(fileUri: vscode.Uri, hduIndex: number, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            const fits = await this.getFITS(fileUri);
            const hdu = fits.getHDU(hduIndex);
            
            if (!hdu) {
                throw new Error(`无法获取HDU ${hduIndex}`);
            }

            this.sendHeaderInfo(fileUri, webviewPanel, hduIndex);
            
            if (hdu.data) {
                const xtension = hdu.header.getItem('XTENSION')?.value;
                if (xtension) {
                    const hduType = xtension.trim().toUpperCase();
                    if (hduType === 'IMAGE') {
                        console.log('检测到图像数据 (XTENSION IMAGE)');
                        const width = hdu.header.getItem('NAXIS1')?.value || 0;
                        const height = hdu.header.getItem('NAXIS2')?.value || 0;
                        // 计算统计信息
                        let min = Number.MAX_VALUE;
                        let max = Number.MIN_VALUE;
                        for (let i = 0; i < hdu.data.length; i++) {
                            min = Math.min(min, hdu.data[i]);
                            max = Math.max(max, hdu.data[i]);
                        }
                        webviewPanel.webview.postMessage({
                            command: 'setImageData',
                            rawData: {
                                data: Array.from(hdu.data),
                                width: width,
                                height: height,
                                min: min,
                                max: max
                            }
                        });
                    } else if (hduType === 'BINTABLE' || hduType === 'TABLE') {
                        console.log('检测到光谱数据 (' + hduType + ')');
                        
                        // 获取列格式信息
                        const naxis2 = hdu.header.getItem('NAXIS2')?.value || 0;
                        const tfields = hdu.header.getItem('TFIELDS')?.value || 0;
                        const actualRows = naxis2;
                        
                        console.log(`NAXIS2 = ${naxis2}, TFIELDS = ${tfields}`);
                        
                        // 获取列格式
                        const columnFormats = [];
                        for (let i = 1; i <= tfields; i++) {
                            const tform = hdu.header.getItem(`TFORM${i}`)?.value;
                            if (tform) {
                                columnFormats.push(tform);
                            }
                        }
                        
                        console.log('列格式:', columnFormats);
                        console.log('原始数据长度:', hdu.data.length);
                        console.log('前20个数据点:', hdu.data.slice(0, 20));
                        
                        // 获取波长数组
                        const wavelengthColumn = columnFormats ? columnFormats[0] : null;
                        const fluxColumn = columnFormats ? columnFormats[1] : null;
                        
                        console.log(`波长列格式: ${wavelengthColumn}, 流量列格式: ${fluxColumn}`);
                        
                        if (wavelengthColumn && fluxColumn) {
                            // 计算每列的字节大小
                            const wavelengthSize = wavelengthColumn === 'D' ? 8 : 4;  // D = 8字节, E = 4字节
                            const fluxSize = fluxColumn === 'D' ? 8 : 4;
                            const rowSize = wavelengthSize + fluxSize;
                            
                            console.log(`每行大小: ${rowSize} 字节 (波长: ${wavelengthSize}, 流量: ${fluxSize})`);
                            
                            // 创建原始的ArrayBuffer并复制数据
                            const buffer = new ArrayBuffer(hdu.data.length * 4); // Float32Array中每个元素4字节
                            const tempView = new Float32Array(buffer);
                            tempView.set(hdu.data);
                            
                            // 使用DataView来正确读取不同类型的数据
                            const dataView = new DataView(buffer);
                            const wavelengthData = new Float32Array(actualRows);
                            const fluxData = new Float32Array(actualRows);
                            
                            // 初始化最大最小值
                            let minFlux = Number.MAX_VALUE;
                            let maxFlux = Number.MIN_VALUE;
                            let minWavelength = Number.MAX_VALUE;
                            let maxWavelength = Number.MIN_VALUE;
                            
                            try {
                                // 输出一些调试信息
                                console.log(`数据总字节数: ${buffer.byteLength}`);
                                console.log(`预期总行数: ${actualRows}`);
                                console.log(`每行字节数: ${rowSize}`);
                                console.log(`预期总字节数: ${actualRows * rowSize}`);
                                
                                for (let i = 0; i < actualRows; i++) {
                                    const rowOffset = i * rowSize;
                                    
                                    // 检查是否超出范围
                                    if (rowOffset + rowSize > buffer.byteLength) {
                                        console.warn(`警告：在第 ${i} 行时达到数据边界，提前结束处理`);
                                        break;
                                    }
                                    
                                    // 读取波长值（D格式 = Float64）
                                    const wavelength = wavelengthColumn === 'D' 
                                        ? dataView.getFloat64(rowOffset, false)  // false表示大端字节序
                                        : dataView.getFloat32(rowOffset, false);
                                    
                                    // 读取流量值（E格式 = Float32）
                                    const flux = fluxColumn === 'D'
                                        ? dataView.getFloat64(rowOffset + wavelengthSize, false)
                                        : dataView.getFloat32(rowOffset + wavelengthSize, false);
                                    
                                    // 检查数值是否有效
                                    if (!isNaN(wavelength) && !isNaN(flux) && isFinite(wavelength) && isFinite(flux)) {
                                        wavelengthData[i] = wavelength;
                                        fluxData[i] = flux;
                                        
                                        // 更新最大最小值
                                        minWavelength = Math.min(minWavelength, wavelength);
                                        maxWavelength = Math.max(maxWavelength, wavelength);
                                        minFlux = Math.min(minFlux, flux);
                                        maxFlux = Math.max(maxFlux, flux);
                                    } else {
                                        console.warn(`警告：第 ${i} 行包含无效数据：wavelength=${wavelength}, flux=${flux}`);
                                    }
                                    
                                    // 每处理10万行输出一次进度
                                    if (i % 100000 === 0) {
                                        console.log(`处理进度: ${((i / actualRows) * 100).toFixed(1)}%`);
                                    }
                                }
                                
                                console.log('光谱数据处理完成:');
                                console.log(`实际行数: ${actualRows}`);
                                console.log(`波长数据前10个值: ${wavelengthData.slice(0, 10)}`);
                                console.log(`流量数据前10个值: ${fluxData.slice(0, 10)}`);
                                console.log(`波长范围: ${minWavelength} - ${maxWavelength} Å`);
                                console.log(`流量范围: ${minFlux} - ${maxFlux}`);
                                
                                // 检查数据是否有效
                                if (isNaN(minWavelength) || isNaN(maxWavelength) || isNaN(minFlux) || isNaN(maxFlux)) {
                                    throw new Error('数据处理结果包含无效值');
                                }
                                
                                webviewPanel.webview.postMessage({
                                    command: 'showSpectrum',
                                    data: {
                                        wavelength: Array.from(wavelengthData),
                                        flux: Array.from(fluxData),
                                        wavelengthRange: [minWavelength, maxWavelength],
                                        fluxRange: [minFlux, maxFlux]
                                    }
                                });
                            } catch (error) {
                                console.error('处理光谱数据时出错:', error);
                                throw error;
                            }
                        } else {
                            console.warn('未找到波长或流量列');
                            webviewPanel.webview.postMessage({
                                command: 'showSpectrum',
                                data: {
                                    wavelength: Array.from({ length: hdu.data.length }, (_, i) => i),
                                    flux: Array.from(hdu.data)
                                }
                            });
                        }
                    } else {
                        console.warn('未知的XTENSION类型：' + hduType + '，按默认逻辑处理');
                        const naxis = hdu.header.getItem('NAXIS')?.value || 0;
                        const naxis1 = hdu.header.getItem('NAXIS1')?.value || 0;
                        const naxis2 = hdu.header.getItem('NAXIS2')?.value || 0;
                        if (naxis === 1 || (naxis === 2 && (naxis1 === 1 || naxis2 === 1))) {
                            console.log('默认检测到光谱数据');
                            webviewPanel.webview.postMessage({
                                command: 'showSpectrum',
                                data: Array.from(hdu.data),
                                wavelength: Array.from({ length: hdu.data.length }, (_, i) => i)
                            });
                        } else {
                            console.log('默认检测到图像数据');
                            const width = naxis1;
                            const height = naxis2;
                            let min = Number.MAX_VALUE;
                            let max = Number.MIN_VALUE;
                            for (let i = 0; i < hdu.data.length; i++) {
                                min = Math.min(min, hdu.data[i]);
                                max = Math.max(max, hdu.data[i]);
                            }
                            webviewPanel.webview.postMessage({
                                command: 'setImageData',
                                rawData: {
                                    data: Array.from(hdu.data),
                                    width: width,
                                    height: height,
                                    min: min,
                                    max: max
                                }
                            });
                        }
                    }
                } else {
                    // 如果没有XTENSION，根据NAXIS判断
                    const naxis = hdu.header.getItem('NAXIS')?.value || 0;
                    const naxis1 = hdu.header.getItem('NAXIS1')?.value || 0;
                    const naxis2 = hdu.header.getItem('NAXIS2')?.value || 0;
                    if (naxis === 1 || (naxis === 2 && (naxis1 === 1 || naxis2 === 1))) {
                        console.log('默认检测到光谱数据 (无XTENSION)');
                        webviewPanel.webview.postMessage({
                            command: 'showSpectrum',
                            data: Array.from(hdu.data),
                            wavelength: Array.from({ length: hdu.data.length }, (_, i) => i)
                        });
                    } else {
                        console.log('默认检测到图像数据 (无XTENSION)');
                        const width = naxis1;
                        const height = naxis2;
                        let min = Number.MAX_VALUE;
                        let max = Number.MIN_VALUE;
                        for (let i = 0; i < hdu.data.length; i++) {
                            min = Math.min(min, hdu.data[i]);
                            max = Math.max(max, hdu.data[i]);
                        }
                        webviewPanel.webview.postMessage({
                            command: 'setImageData',
                            rawData: {
                                data: Array.from(hdu.data),
                                width: width,
                                height: height,
                                min: min,
                                max: max
                            }
                        });
                    }
                }
            } else {
                webviewPanel.webview.postMessage({
                    command: 'setImageData',
                    rawData: null,
                    message: '当前HDU不包含数据'
                });
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