import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../models/Logger';

/**
 * Webview服务类
 * 提供与webview相关的操作
 */
export class WebviewService {
    private logger: Logger;
    
    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        this.logger = Logger.getInstance();
    }
    
    /**
     * 获取webview的HTML内容
     */
    public getHtmlForWebview(webview: vscode.Webview): string {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'fitsViewer.html');
        this.logger.debug(`HTML文件路径: ${htmlPath.fsPath}`);
        
        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
        this.logger.debug('已读取HTML内容');
        
        return htmlContent;
    }
    
    /**
     * 配置webview选项
     */
    public configureWebview(webview: vscode.Webview): void {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
                vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'fits-temp'))
            ]
        };
    }
    
    /**
     * 发送消息到webview
     */
    public postMessage(webview: vscode.Webview, message: any): void {
        webview.postMessage(message);
    }
    
    /**
     * 发送加载状态消息
     */
    public sendLoadingMessage(webview: vscode.Webview, message: string): void {
        this.postMessage(webview, {
            command: 'setImageData',
            rawData: null,
            message: message
        });
    }
    
    /**
     * 发送文件名
     */
    public sendFileName(webview: vscode.Webview, fileName: string): void {
        this.postMessage(webview, {
            command: 'setFileName',
            fileName: fileName
        });
    }
    
    /**
     * 发送对象名称
     */
    public sendObjectName(webview: vscode.Webview, objectName: string): void {
        this.postMessage(webview, {
            command: 'setObjectName',
            objectName: objectName
        });
    }
    
    /**
     * 发送HDU数量
     */
    public sendHDUCount(webview: vscode.Webview, count: number): void {
        this.postMessage(webview, {
            command: 'setHDUCount',
            count: count
        });
    }
    
    /**
     * 发送头信息摘要
     */
    public sendHeaderSummary(webview: vscode.Webview, headerItems: { key: string, value: any, comment?: string }[]): void {
        const keyItems = ['BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'DATE-OBS', 'EXPTIME', 'TELESCOP', 'INSTRUME'];
        
        let headerSummary = '<table style="width:100%">';
        for (const key of keyItems) {
            const item = headerItems.find(item => item.key === key);
            if (item) {
                headerSummary += `<tr><td>${key}</td><td>${item.value}</td></tr>`;
            }
        }
        headerSummary += '</table>';
        
        this.postMessage(webview, {
            command: 'setHeaderSummary',
            html: headerSummary
        });
    }
    
    /**
     * 发送头信息详情
     */
    public sendHeaderInfo(webview: vscode.Webview, headerItems: { key: string, value: any, comment?: string }[]): void {
        // 格式化头文件信息为文本格式
        let headerText = '';
        for (const item of headerItems) {
            const valueStr = typeof item.value === 'string' ? `'${item.value}'` : item.value;
            const commentStr = item.comment ? ` / ${item.comment}` : '';
            headerText += `${item.key.padEnd(8)} = ${String(valueStr).padEnd(20)}${commentStr}\n`;
        }
        
        this.postMessage(webview, {
            command: 'setHeaderInfo',
            text: headerText
        });
    }
    
    /**
     * 发送像素值信息
     */
    public sendPixelInfo(webview: vscode.Webview, x: number, y: number, value: number, wcs1: string = '-', wcs2: string = '-'): void {
        this.postMessage(webview, {
            command: 'setPixelInfo',
            x: x,
            y: y,
            value: value,
            wcs1: wcs1,
            wcs2: wcs2
        });
    }
    
    /**
     * 发送图像数据文件URI
     */
    public sendImageDataFileUri(webview: vscode.Webview, fileUri: vscode.Uri): void {
        this.postMessage(webview, {
            command: 'setImageDataFromFile',
            fileUri: webview.asWebviewUri(fileUri).toString()
        });
    }
    
    /**
     * 发送光谱数据
     */
    public sendSpectrumData(
        webview: vscode.Webview, 
        wavelength: number[], 
        flux: number[], 
        wavelengthUnit?: string, 
        fluxUnit?: string,
        columns?: any[],
        wavelengthColumn?: string,
        fluxColumn?: string
    ): void {
        this.postMessage(webview, {
            command: 'showSpectrum',
            data: {
                wavelength: wavelength,
                flux: flux,
                wavelengthUnit: wavelengthUnit || 'Å',
                fluxUnit: fluxUnit || 'Counts'
            },
            columns: columns,
            wavelengthColumn: wavelengthColumn,
            fluxColumn: fluxColumn
        });
    }
} 