import * as vscode from 'vscode';
import { Logger } from '../models/Logger';

/**
 * Webview message handler interface | Webview消息处理器接口
 * Defines methods for handling different types of webview messages | 定义处理不同类型webview消息的方法
 */
export interface IWebviewMessageHandler {
    handleWebviewReady(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void>;
    handleGetPixelValue(uri: vscode.Uri, x: number, y: number, webviewPanel: vscode.WebviewPanel): Promise<void>;
    handleSetScaleType(uri: vscode.Uri, scaleType: string, webviewPanel: vscode.WebviewPanel): Promise<void>;
    handleGetHeaderInfo(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void>;
    handleSwitchHDU(uri: vscode.Uri, hduIndex: number, webviewPanel: vscode.WebviewPanel): Promise<void>;
    handleUpdateSpectrum(uri: vscode.Uri, wavelengthColumn: string, fluxColumn: string, webviewPanel: vscode.WebviewPanel): Promise<void>;
    handleShowTable(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void>;
    handleReturnToSpectrum(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void>;
}

/**
 * Webview message handler class | Webview消息处理器类
 * Responsible for dispatching and handling messages from webview | 负责分发和处理来自webview的消息
 */
export class WebviewMessageHandler {
    private logger: Logger;
    
    constructor(
        private readonly handler: IWebviewMessageHandler
    ) {
        this.logger = Logger.getInstance();
    }
    
    /**
     * Handle messages from webview | 处理来自webview的消息
     */
    public async handleMessage(
        message: any, 
        document: vscode.CustomDocument, 
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        this.logger.debug(`Received webview message: ${message.command} | 收到webview消息: ${message.command}`);
        
        try {
            switch (message.command) {
                case 'webviewReady':
                    await this.handler.handleWebviewReady(document.uri, webviewPanel);
                    break;
                    
                case 'getPixelValue':
                    await this.handler.handleGetPixelValue(document.uri, message.x, message.y, webviewPanel);
                    break;
                    
                case 'setScaleType':
                    await this.handler.handleSetScaleType(document.uri, message.scaleType, webviewPanel);
                    break;
                    
                case 'getHeaderInfo':
                    await this.handler.handleGetHeaderInfo(document.uri, webviewPanel);
                    break;
                    
                case 'switchHDU':
                    await this.handler.handleSwitchHDU(document.uri, message.hduIndex, webviewPanel);
                    break;
                    
                case 'updateSpectrum':
                    await this.handler.handleUpdateSpectrum(document.uri, message.wavelengthColumn, message.fluxColumn, webviewPanel);
                    break;
                    
                case 'showTable':
                    await this.handler.handleShowTable(document.uri, webviewPanel);
                    break;
                    
                case 'returnToSpectrum':
                    await this.handler.handleReturnToSpectrum(document.uri, webviewPanel);
                    break;

                case 'transformTypeResponse':
                case 'scaleValuesResponse':
                    // These are responses to extension queries, no handler needed
                    break;
                    
                default:
                    this.logger.warn(`Unknown webview message command: ${message.command} | 未知的webview消息命令: ${message.command}`);
            }
        } catch (error) {
            this.logger.error(`Error handling webview message: ${error} | 处理webview消息时出错: ${error}`);
            
            // Send error message to webview | 向webview发送错误消息
            webviewPanel.webview.postMessage({
                command: 'error',
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }
} 