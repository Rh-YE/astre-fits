// Get vscode API | 获取vscode API
const vscode = (() => {
    try {
        return acquireVsCodeApi();
    } catch (error) {
        console.error('Failed to get vscode API:', error);
        return null;
    }
})();

// Log function | 日志函数
function log(message) {
    console.log(message);
}


// Calculate appropriate scale interval | 计算合适的刻度间隔
function calculateNiceStep(roughStep) {
    const exponent = Math.floor(Math.log10(roughStep));
    const fraction = roughStep / Math.pow(10, exponent);
    
    let niceFraction;
    if (fraction < 1.5) {
        niceFraction = 1;
    } else if (fraction < 3) {
        niceFraction = 2;
    } else if (fraction < 7) {
        niceFraction = 5;
    } else {
        niceFraction = 10;
    }
    
    return niceFraction * Math.pow(10, exponent);
}

// Find closest data point (X-axis only) | 查找最近的数据点（只考虑X轴方向）
function findClosestDataPoint(points, targetX) {
    if (!points || points.length === 0) return null;
    if (points.length === 1) return points[0];
    
    // Only consider X-axis distance | 只考虑X轴方向的距离
    return points.reduce((closest, current) => {
        const currentDistance = Math.abs(current.x - targetX);
        const closestDistance = Math.abs(closest.x - targetX);
        return currentDistance < closestDistance ? current : closest;
    });
}

// Update status information | 更新状态信息
function updateStatusInfo(currentImageData, zoomLevel) {
    const isUltraLargeImage = currentImageData.width * currentImageData.height > 80000000 || 
                             currentImageData.width > 16000 || 
                             currentImageData.height > 16000;
    
    const statusInfo = document.getElementById('status-info');
    if (statusInfo) {
        let statusText = `Size: ${currentImageData.width}x${currentImageData.height}, `;
        statusText += `Zoom: ${Math.round(zoomLevel * 100)}%, `;
        statusText += `Data range: ${currentImageData.min.toExponential(4)} - ${currentImageData.max.toExponential(4)}`;
        
        if (isUltraLargeImage) {
            statusText += ' (Ultra large image mode)';
        }
        
        statusInfo.textContent = statusText;
    }
}

// Show zoom indicator | 显示缩放指示器
function showZoomIndicator(zoomIndicator, level, timeout = 2000) {
    zoomIndicator.textContent = `Zoom: ${Math.round(level * 100)}%`;
    zoomIndicator.style.display = 'block';
    
    setTimeout(() => {
        zoomIndicator.style.display = 'none';
    }, timeout);
}

// Export common functions and variables | 导出共用函数和变量
export {
    vscode,
    log,
    calculateNiceStep,
    findClosestDataPoint,
    updateStatusInfo,
    showZoomIndicator
}; 