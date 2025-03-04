// The module 'vscode' contains the VS Code extensibility API | vscode模块包含VS Code扩展性API
// Import the module and reference it with the alias vscode in your code below | 导入该模块并在代码中使用vscode作为别名
import * as vscode from 'vscode';
import { FitsViewerProvider } from './fitsViewerProvider';
import { Logger, LogLevel } from './models/Logger';

// This method is called when your extension is activated | 当扩展被激活时调用此方法
// Your extension is activated the very first time the command is executed | 扩展在第一次执行命令时被激活
export function activate(context: vscode.ExtensionContext) {
	const logger = Logger.getInstance();
	logger.setLogLevel(LogLevel.INFO);
	
	// Log extension activation | 记录扩展激活信息
	logger.info('扩展 "astre-fits" 已激活');

	// Register FITS file viewer | 注册FITS文件查看器
	context.subscriptions.push(FitsViewerProvider.register(context));

	// The command has been defined in the package.json file | 命令已在package.json文件中定义
	// Now provide the implementation of the command with registerCommand | 现在使用registerCommand提供命令的实现
	// The commandId parameter must match the command field in package.json | commandId参数必须与package.json中的command字段匹配
	const disposable = vscode.commands.registerCommand('astre-fits.helloWorld', () => {
		// The code you place here will be executed every time your command is executed | 每次执行命令时都会执行此处的代码
		// Display a message box to the user | 向用户显示消息框
		logger.info('执行命令: astre-fits.helloWorld');
		vscode.window.showInformationMessage('Hello World from Astre Fits!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated | 当扩展被停用时调用此方法
export function deactivate() {
	Logger.getInstance().info('扩展 "astre-fits" 已停用');
}
