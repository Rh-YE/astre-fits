// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { FitsViewerProvider } from './fitsViewerProvider';
import { Logger, LogLevel } from './models/Logger';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// 初始化日志记录器
	const logger = Logger.getInstance();
	logger.setLogLevel(LogLevel.INFO);
	
	// 记录扩展激活信息
	logger.info('扩展 "astre-fits" 已激活');

	// 注册FITS文件查看器
	context.subscriptions.push(FitsViewerProvider.register(context));

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('astre-fits.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		logger.info('执行命令: astre-fits.helloWorld');
		vscode.window.showInformationMessage('Hello World from Astre Fits!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	Logger.getInstance().info('扩展 "astre-fits" 已停用');
}
