// 获取vscode API
const vscode = (() => {
    try {
        return acquireVsCodeApi();
    } catch (error) {
        console.error('获取vscode API失败:', error);
        return null;
    }
})();

// 日志函数
function log(message) {
    console.log(message);
}


// 计算合适的刻度间隔
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

// 查找最近的数据点（只考虑X轴方向）
function findClosestDataPoint(points, targetX) {
    if (!points || points.length === 0) return null;
    if (points.length === 1) return points[0];
    
    // 只考虑X轴方向的距离
    return points.reduce((closest, current) => {
        const currentDistance = Math.abs(current.x - targetX);
        const closestDistance = Math.abs(closest.x - targetX);
        return currentDistance < closestDistance ? current : closest;
    });
}

// 更新状态信息
function updateStatusInfo(currentImageData, zoomLevel) {
    const isUltraLargeImage = currentImageData.width * currentImageData.height > 80000000 || 
                             currentImageData.width > 16000 || 
                             currentImageData.height > 16000;
    
    const statusInfo = document.getElementById('status-info');
    if (statusInfo) {
        let statusText = `尺寸: ${currentImageData.width}x${currentImageData.height}, `;
        statusText += `缩放: ${Math.round(zoomLevel * 100)}%, `;
        statusText += `数据范围: ${currentImageData.min.toExponential(4)} - ${currentImageData.max.toExponential(4)}`;
        
        if (isUltraLargeImage) {
            statusText += ' (超大图像模式)';
        }
        
        statusInfo.textContent = statusText;
    }
}

// 显示缩放指示器
function showZoomIndicator(zoomIndicator, level, timeout = 2000) {
    zoomIndicator.textContent = `缩放: ${Math.round(level * 100)}%`;
    zoomIndicator.style.display = 'block';
    
    setTimeout(() => {
        zoomIndicator.style.display = 'none';
    }, timeout);
}

// 导出共用函数和变量
export {
    vscode,
    log,
    calculateNiceStep,
    findClosestDataPoint,
    updateStatusInfo,
    showZoomIndicator
}; 