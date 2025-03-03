import { vscode, log, calculateNiceStep, findClosestDataPoint } from './common.js';

// 光谱查看器类
class SpectrumViewer {
    constructor() {
        // 光谱数据相关变量
        this.currentSpectrumData = null;
        this.availableColumns = [];
        this.selectedWavelengthColumn = "";
        this.selectedFluxColumn = "";
        
        // 缩放和平移相关变量
        this.spectrumZoomLevelX = 1.0;  // X轴缩放级别
        this.spectrumZoomLevelY = 1.0;  // Y轴缩放级别
        this.spectrumPanOffsetX = 0;
        this.spectrumPanOffsetY = 0;
        this.spectrumIsDragging = false;
        this.spectrumDragStartX = 0;
        this.spectrumDragStartY = 0;
        this.spectrumLastPanOffsetX = 0;
        this.spectrumLastPanOffsetY = 0;
        
        // 放大框相关变量
        this.isZoomBoxMode = false;
        this.isDrawingZoomBox = false;
        this.zoomBoxStartX = 0;
        this.zoomBoxStartY = 0;
        this.zoomBoxEndX = 0;
        this.zoomBoxEndY = 0;
        this.zoomBoxElement = null;
        
        // DOM元素
        this.canvas = document.getElementById('spectrum-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.container = document.querySelector('.image-container');
        this.wavelengthSelector = document.getElementById('wavelength-column-selector');
        this.fluxSelector = document.getElementById('flux-column-selector');
        this.zoomBoxButton = document.getElementById('zoom-box-button');
        
        // 创建辅助线叠加层
        this.crosshairOverlay = document.createElement('canvas');
        this.crosshairOverlay.style.position = 'absolute';
        this.crosshairOverlay.style.top = '0';
        this.crosshairOverlay.style.left = '0';
        this.crosshairOverlay.style.pointerEvents = 'none';
        this.crosshairOverlay.style.zIndex = '10';
        this.container.appendChild(this.crosshairOverlay);
        
        // 创建矩形框元素
        this.zoomBoxElement = document.createElement('div');
        this.zoomBoxElement.style.position = 'absolute';
        this.zoomBoxElement.style.border = '2px dashed yellow';
        this.zoomBoxElement.style.backgroundColor = 'rgba(255, 255, 0, 0.1)';
        this.zoomBoxElement.style.pointerEvents = 'none';
        this.zoomBoxElement.style.display = 'none';
        this.zoomBoxElement.style.zIndex = '1000';
        this.container.appendChild(this.zoomBoxElement);
        
        // 初始化事件监听
        this.initEventListeners();
    }
    
    // 初始化事件监听器
    initEventListeners() {
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this)); // 光谱滚轮缩放
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this)); // 局部放大开启按钮单击
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this)); // 光谱Canvas的鼠标移动事件 - 拖动、绘制矩形框和显示值
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave.bind(this));  // 光谱Canvas的鼠标离开事件 - 清除辅助线
        window.addEventListener('mouseup', this.handleMouseUp.bind(this)); // 窗口的鼠标抬起事件 - 结束拖动或矩形框选择
        
        if (this.zoomBoxButton) {
            this.zoomBoxButton.addEventListener('click', this.handleZoomBoxButtonClick.bind(this)); // 放大按钮点击事件
        }
        
        // 列选择器变更事件
        if (this.wavelengthSelector) {
            this.wavelengthSelector.addEventListener('change', () => {
                this.selectedWavelengthColumn = this.wavelengthSelector.value;
                this.updateSpectrumWithSelectedColumns();
            });
        }
        
        if (this.fluxSelector) {
            this.fluxSelector.addEventListener('change', () => {
                this.selectedFluxColumn = this.fluxSelector.value;
                this.updateSpectrumWithSelectedColumns();
            });
        }
    }
    
    // 处理放大按钮点击
    handleZoomBoxButtonClick() {
        this.isZoomBoxMode = !this.isZoomBoxMode;
        
        if (this.isZoomBoxMode) {
            this.zoomBoxButton.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
            this.zoomBoxButton.textContent = '取消放大';
            this.canvas.style.cursor = 'crosshair';
        } else {
            this.zoomBoxButton.style.backgroundColor = 'var(--vscode-button-background)';
            this.zoomBoxButton.textContent = '放大';
            this.canvas.style.cursor = 'default';
            this.zoomBoxElement.style.display = 'none';
        }
    }
    
    // 更新矩形框位置
    updateZoomBoxPosition() {
        const left = Math.min(this.zoomBoxStartX, this.zoomBoxEndX);
        const top = Math.min(this.zoomBoxStartY, this.zoomBoxEndY);
        const width = Math.abs(this.zoomBoxEndX - this.zoomBoxStartX);
        const height = Math.abs(this.zoomBoxEndY - this.zoomBoxStartY);
        
        this.zoomBoxElement.style.left = `${left}px`;
        this.zoomBoxElement.style.top = `${top}px`;
        this.zoomBoxElement.style.width = `${width}px`;
        this.zoomBoxElement.style.height = `${height}px`;
    }
    
    // 处理鼠标滚轮事件
    handleWheel(event) {
        event.preventDefault();
        
        const spectrumData = this.canvas.dataset.spectrumData;
        if (!spectrumData) return;
        
        // 获取当前光谱数据
        const data = JSON.parse(spectrumData);
        if (!data || !data.wavelength || !data.flux) return;
        
        // 计算缩放因子
        const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
        const newZoomLevelX = Math.max(0.1, Math.min(50, this.spectrumZoomLevelX * zoomFactor));
        const newZoomLevelY = Math.max(0.1, Math.min(50, this.spectrumZoomLevelY * zoomFactor));
        
        // 获取鼠标在Canvas上的位置
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        // 设置边距
        const margin = { top: 40, right: 40, bottom: 60, left: 70 };
        
        // 只有当鼠标在绘图区域内时才进行缩放
        if (mouseX >= margin.left && mouseX <= (this.canvas.width - margin.right) &&
            mouseY >= margin.top && mouseY <= (this.canvas.height - margin.bottom)) {
            
            // 获取数据范围
            const minX = Math.min(...data.wavelength);
            const maxX = Math.max(...data.wavelength);
            const minY = Math.min(...data.flux);
            const maxY = Math.max(...data.flux);
            const plotWidth = this.canvas.width - margin.left - margin.right;
            const plotHeight = this.canvas.height - margin.top - margin.bottom;
            
            // 计算当前可见数据范围
            const scaleX = plotWidth / (maxX - minX);
            const scaleY = plotHeight / (maxY - minY);
            const visibleMinX = minX + this.spectrumPanOffsetX / (scaleX * this.spectrumZoomLevelX);
            const visibleMinY = minY + this.spectrumPanOffsetY / (scaleY * this.spectrumZoomLevelY);
            
            // 计算鼠标在数据坐标系中的位置
            const mouseDataX = visibleMinX + (mouseX - margin.left) / (scaleX * this.spectrumZoomLevelX);
            const mouseDataY = visibleMinY + (this.canvas.height - margin.bottom - mouseY) / (scaleY * this.spectrumZoomLevelY);
            
            // 更新缩放级别
            this.spectrumZoomLevelX = newZoomLevelX;
            this.spectrumZoomLevelY = newZoomLevelY;
            
            // 计算新的可见数据范围，保持鼠标指向的数据点不变
            const newScaleX = plotWidth / (maxX - minX);
            const newScaleY = plotHeight / (maxY - minY);
            const newVisibleMinX = mouseDataX - (mouseX - margin.left) / (newScaleX * this.spectrumZoomLevelX);
            const newVisibleMinY = mouseDataY - (this.canvas.height - margin.bottom - mouseY) / (newScaleY * this.spectrumZoomLevelY);
            
            // 更新平移偏移量，使鼠标位置保持在同一数据点上
            this.spectrumPanOffsetX = (newVisibleMinX - minX) * newScaleX * this.spectrumZoomLevelX;
            this.spectrumPanOffsetY = (newVisibleMinY - minY) * newScaleY * this.spectrumZoomLevelY;
            
            // 重新渲染光谱
            this.renderSpectrum(data, true);
        }
    }
    
    // 处理鼠标按下事件
    handleMouseDown(event) {
        if (event.button !== 0) return; // 只处理左键
        
        // 获取Canvas的位置和尺寸
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        // 设置边距
        const margin = { top: 40, right: 40, bottom: 60, left: 70 };
        
        // 检查是否在绘图区域内
        if (mouseX >= margin.left && mouseX <= (this.canvas.width - margin.right) &&
            mouseY >= margin.top && mouseY <= (this.canvas.height - margin.bottom)) {
            
            if (this.isZoomBoxMode) {
                // 开始绘制矩形框
                this.isDrawingZoomBox = true;
                this.zoomBoxStartX = mouseX;
                this.zoomBoxStartY = mouseY;
                this.zoomBoxEndX = mouseX;
                this.zoomBoxEndY = mouseY;
                
                // 显示矩形框
                this.updateZoomBoxPosition();
                this.zoomBoxElement.style.display = 'block';
            } else {
                // 正常拖动行为
                this.spectrumIsDragging = true;
                this.spectrumDragStartX = event.clientX;
                this.spectrumDragStartY = event.clientY;
                this.spectrumLastPanOffsetX = this.spectrumPanOffsetX;
                this.spectrumLastPanOffsetY = this.spectrumPanOffsetY;
                
                // 改变鼠标样式
                this.canvas.style.cursor = 'grabbing';
            }
        }
    }
    
    // 处理鼠标移动事件
    handleMouseMove(event) {
        const rect = this.canvas.getBoundingClientRect();
        
        // 处理矩形框绘制
        if (this.isDrawingZoomBox) {
            this.zoomBoxEndX = event.clientX - rect.left;
            this.zoomBoxEndY = event.clientY - rect.top;
            this.updateZoomBoxPosition();
            return;
        }
        
        // 处理拖动
        if (this.spectrumIsDragging) {
            const deltaX = event.clientX - this.spectrumDragStartX;
            const deltaY = event.clientY - this.spectrumDragStartY;
            
            this.spectrumPanOffsetX = this.spectrumLastPanOffsetX - deltaX;
            this.spectrumPanOffsetY = this.spectrumLastPanOffsetY + deltaY;
            
            const spectrumData = this.canvas.dataset.spectrumData;
            if (spectrumData) {
                const data = JSON.parse(spectrumData);
                this.renderSpectrum(data, true);
            }
            return;
        }
        
        // 检查鼠标是否在Canvas上
        if (event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom) {
            
            const spectrumData = this.canvas.dataset.spectrumData;
            if (!spectrumData) return;
            
            const data = JSON.parse(spectrumData);
            if (!data || !data.wavelength || !data.flux) return;
            
            // 计算Canvas上的坐标
            const canvasX = event.clientX - rect.left;
            const canvasY = event.clientY - rect.top;
            
            // 设置边距
            const margin = { top: 40, right: 40, bottom: 60, left: 70 };
            
            // 检查是否在绘图区域内
            if (canvasX >= margin.left && canvasX <= (this.canvas.width - margin.right) &&
                canvasY >= margin.top && canvasY <= (this.canvas.height - margin.bottom)) {
                
                // 过滤无效数据点
                const validData = data.wavelength.map((x, i) => ({
                    x: x,
                    y: data.flux[i],
                    index: i
                })).filter(point => 
                    !isNaN(point.x) && !isNaN(point.y) && 
                    isFinite(point.x) && isFinite(point.y)
                );
                
                if (validData.length === 0) return;
                
                // 计算数据范围
                const minX = Math.min(...validData.map(p => p.x));
                const maxX = Math.max(...validData.map(p => p.x));
                const minY = Math.min(...validData.map(p => p.y));
                const maxY = Math.max(...validData.map(p => p.y));
                
                // 添加padding到数据范围
                const rangeY = maxY - minY;
                const paddedMinY = minY - rangeY * 0.05;
                const paddedMaxY = maxY + rangeY * 0.05;
                
                // 计算可见数据范围，考虑缩放和平移
                const plotWidth = this.canvas.width - margin.left - margin.right;
                const plotHeight = this.canvas.height - margin.top - margin.bottom;
                const scaleX = plotWidth / (maxX - minX);
                const scaleY = plotHeight / (paddedMaxY - paddedMinY);
                
                const visibleMinX = minX + this.spectrumPanOffsetX / (scaleX * this.spectrumZoomLevelX);
                const visibleMaxX = visibleMinX + (plotWidth / scaleX) / this.spectrumZoomLevelX;
                const visibleMinY = paddedMinY + this.spectrumPanOffsetY / (scaleY * this.spectrumZoomLevelY);
                const visibleMaxY = visibleMinY + (plotHeight / scaleY) / this.spectrumZoomLevelY;
                
                // 在可见范围内查找所有点
                const visiblePoints = validData.filter(point => 
                    point.x >= visibleMinX && point.x <= visibleMaxX
                ).sort((a, b) => a.x - b.x);  // 确保点按X坐标排序
                
                if (visiblePoints.length > 0) {
                    // 计算鼠标在数据坐标系中的位置
                    const mouseDataX = visibleMinX + ((canvasX - margin.left) / plotWidth) * (visibleMaxX - visibleMinX);
                    
                    let closestPoint;
                    
                    // 如果鼠标在绘图区域左侧，选择第一个点
                    if (canvasX <= margin.left) {
                        closestPoint = visiblePoints[0];
                    }
                    // 如果鼠标在绘图区域右侧，选择最后一个点
                    else if (canvasX >= this.canvas.width - margin.right) {
                        closestPoint = visiblePoints[visiblePoints.length - 1];
                    }
                    // 鼠标在绘图区域内，找到最近的点
                    else {
                        // 找到最近的点
                        let minDist = Infinity;
                        let minIndex = 0;
                        
                        for (let i = 0; i < visiblePoints.length; i++) {
                            const dist = Math.abs(visiblePoints[i].x - mouseDataX);
                            if (dist < minDist) {
                                minDist = dist;
                                minIndex = i;
                            }
                        }
                        
                        closestPoint = visiblePoints[minIndex];
                    }
                    
                    // 计算最近点在屏幕上的精确位置
                    const pointX = margin.left + ((closestPoint.x - visibleMinX) / (visibleMaxX - visibleMinX)) * plotWidth;
                    const pointY = this.canvas.height - margin.bottom - 
                                 ((closestPoint.y - visibleMinY) / (visibleMaxY - visibleMinY)) * plotHeight;
                    
                    // 更新坐标和值显示
                    document.getElementById('image-coords-x').textContent = closestPoint.x.toFixed(2);
                    document.getElementById('image-coords-y').textContent = closestPoint.y.toFixed(2);
                    document.getElementById('pixel-value').textContent = closestPoint.y.toString();
                    
                    // 绘制辅助线在最近的数据点位置
                    this.drawCrosshair(pointX, pointY);
                } else {
                    this.clearCrosshair();
                }
            } else {
                // 如果鼠标不在绘图区域内，清除辅助线
                this.clearCrosshair();
            }
        }
    }
    
    // 处理鼠标抬起事件
    handleMouseUp() {
        if (this.spectrumIsDragging) {
            this.spectrumIsDragging = false;
            this.canvas.style.cursor = 'default';
        }
        
        if (this.isDrawingZoomBox) {
            this.isDrawingZoomBox = false;
            
            // 隐藏矩形框
            this.zoomBoxElement.style.display = 'none';
            
            // 获取矩形框的位置和尺寸（屏幕坐标）
            const left = Math.min(this.zoomBoxStartX, this.zoomBoxEndX);
            const top = Math.min(this.zoomBoxStartY, this.zoomBoxEndY);
            const width = Math.abs(this.zoomBoxEndX - this.zoomBoxStartX);
            const height = Math.abs(this.zoomBoxEndY - this.zoomBoxStartY);
            
            // 如果矩形框太小，不执行放大操作
            if (width < 10 || height < 10) {
                return;
            }
            
            // 获取光谱数据
            const spectrumData = this.canvas.dataset.spectrumData;
            if (!spectrumData) return;
            
            const data = JSON.parse(spectrumData);
            if (!data || !data.wavelength || !data.flux) return;
            
            // 设置边距
            const margin = { top: 40, right: 40, bottom: 60, left: 70 };
            const plotWidth = this.canvas.width - margin.left - margin.right;
            const plotHeight = this.canvas.height - margin.top - margin.bottom;
            
            // 计算数据范围
            const minX = Math.min(...data.wavelength);
            const maxX = Math.max(...data.wavelength);
            const minY = Math.min(...data.flux);
            const maxY = Math.max(...data.flux);
            
            // 确保矩形框在绘图区域内
            const adjustedLeft = Math.max(left, margin.left);
            const adjustedRight = Math.min(left + width, this.canvas.width - margin.right);
            const adjustedTop = Math.max(top, margin.top);
            const adjustedBottom = Math.min(top + height, this.canvas.height - margin.bottom);
            
            // 计算数据到屏幕的映射比例
            const scaleX = plotWidth / (maxX - minX);
            const scaleY = plotHeight / (maxY - minY);
            
            // 计算当前可见数据范围
            const visibleMinX = minX + this.spectrumPanOffsetX / (scaleX * this.spectrumZoomLevelX);
            const visibleMinY = minY + this.spectrumPanOffsetY / (scaleY * this.spectrumZoomLevelY);
            
            // 将屏幕坐标转换为数据坐标
            const boxMinX = visibleMinX + (adjustedLeft - margin.left) / (scaleX * this.spectrumZoomLevelX);
            const boxMaxX = visibleMinX + (adjustedRight - margin.left) / (scaleX * this.spectrumZoomLevelX);
            const boxMinY = visibleMinY + (this.canvas.height - adjustedBottom - margin.bottom) / (scaleY * this.spectrumZoomLevelY);
            const boxMaxY = visibleMinY + (this.canvas.height - adjustedTop - margin.bottom) / (scaleY * this.spectrumZoomLevelY);
            
            // 计算矩形框的范围和中心点
            const boxWidthX = boxMaxX - boxMinX;
            const boxWidthY = boxMaxY - boxMinY;
            const boxCenterX = (boxMinX + boxMaxX) / 2;
            const boxCenterY = (boxMinY + boxMaxY) / 2;
            
            // 计算新的可见范围，以矩形框为中心，两侧各扩展半个矩形框宽度
            const targetWidthX = boxWidthX * 2;
            const targetWidthY = boxWidthY * 2;
            
            // 计算新的缩放级别
            const newZoomLevelX = Math.min(50, (maxX - minX) / targetWidthX * this.spectrumZoomLevelX);
            const newZoomLevelY = Math.min(50, (maxY - minY) / targetWidthY * this.spectrumZoomLevelY);
            
            // 计算新的平移偏移，使矩形框居中
            const newVisibleMinX = boxCenterX - targetWidthX / 2;
            const newVisibleMinY = boxCenterY - targetWidthY / 2;
            const newPanOffsetX = (newVisibleMinX - minX) * scaleX * newZoomLevelX;
            const newPanOffsetY = (newVisibleMinY - minY) * scaleY * newZoomLevelY;
            
            // 更新缩放和平移状态
            this.spectrumZoomLevelX = newZoomLevelX;
            this.spectrumZoomLevelY = newZoomLevelY;
            this.spectrumPanOffsetX = newPanOffsetX;
            this.spectrumPanOffsetY = newPanOffsetY;
            
            // 重新渲染光谱
            this.renderSpectrum(data, true);
            
            // 如果放大模式是一次性的，自动关闭放大模式
            if (this.isZoomBoxMode) {
                this.isZoomBoxMode = false;
                this.zoomBoxButton.style.backgroundColor = 'var(--vscode-button-background)';
                this.zoomBoxButton.textContent = '放大';
                this.canvas.style.cursor = 'default';
            }
        }
    }
    
    // 处理鼠标离开事件
    handleMouseLeave() {
        this.clearCrosshair();
    }
    
    // 清除光谱十字准线
    clearCrosshair() {
        const ctx = this.crosshairOverlay.getContext('2d');
        ctx.clearRect(0, 0, this.crosshairOverlay.width, this.crosshairOverlay.height);
    }
    
    // 绘制光谱十字准线
    drawCrosshair(x, y) {
        // 调整叠加层大小以匹配容器
        this.crosshairOverlay.width = this.container.clientWidth;
        this.crosshairOverlay.height = this.container.clientHeight;
        
        const ctx = this.crosshairOverlay.getContext('2d');
        const margin = { top: 40, right: 40, bottom: 60, left: 70 };
        
        // 清除之前的辅助线
        ctx.clearRect(0, 0, this.crosshairOverlay.width, this.crosshairOverlay.height);
        
        // 检查坐标是否在绘图区域内
        if (x < margin.left || x > (this.canvas.width - margin.right) ||
            y < margin.top || y > (this.canvas.height - margin.bottom)) {
            return;
        }
        
        // 设置辅助线样式
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        
        // 绘制水平辅助线
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(this.canvas.width - margin.right, y);
        ctx.stroke();
        
        // 绘制垂直辅助线
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, this.canvas.height - margin.bottom);
        ctx.stroke();
        
        // 在交叉点绘制一个小圆圈
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255, 255, 0, 0.9)';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    
    // 渲染光谱
    renderSpectrum(data, update = false) {
        if (!data || !data.wavelength || !data.flux || 
            !Array.isArray(data.wavelength) || !Array.isArray(data.flux) || 
            data.wavelength.length === 0 || data.flux.length === 0) {
            log('无效的光谱数据');
            return;
        }

        if (data.wavelength.length !== data.flux.length) {
            log(`数据长度不匹配：flux=${data.flux.length}, wavelength=${data.wavelength.length}`);
            return;
        }

        // 保存光谱数据到Canvas的dataset属性，以便鼠标移动事件使用
        this.canvas.dataset.spectrumData = JSON.stringify(data);
        
        // 确保canvas大小与容器大小一致
        const container = this.container;
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        // 如果canvas大小与容器大小不一致，则更新canvas大小
        if (this.canvas.width !== containerWidth || this.canvas.height !== containerHeight) {
            this.canvas.width = containerWidth;
            this.canvas.height = containerHeight;
        }
        
        // 如果是更新模式，不需要重置缩放和平移状态
        if (!update) {
            // 重置缩放和平移状态
            this.spectrumZoomLevelX = 1.0;
            this.spectrumZoomLevelY = 1.0;
            this.spectrumPanOffsetX = 0;
            this.spectrumPanOffsetY = 0;
        }
        
        // 清空画布
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 计算数据范围
        let minY = Infinity;
        let maxY = -Infinity;
        let minX = Infinity;
        let maxX = -Infinity;

        // 过滤无效值并计算范围
        const validData = [];
        for (let i = 0; i < data.wavelength.length; i++) {
            if (!isNaN(data.flux[i]) && !isNaN(data.wavelength[i]) && 
                isFinite(data.flux[i]) && isFinite(data.wavelength[i])) {
                validData.push({x: data.wavelength[i], y: data.flux[i]});
                minY = Math.min(minY, data.flux[i]);
                maxY = Math.max(maxY, data.flux[i]);
                minX = Math.min(minX, data.wavelength[i]);
                maxX = Math.max(maxX, data.wavelength[i]);
            }
        }

        if (validData.length === 0) {
            log('错误：没有有效的数据点');
            return;
        }

        // 设置边距
        const margin = { top: 40, right: 40, bottom: 60, left: 70 };
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // 添加一些padding到数据范围
        const rangeY = maxY - minY;
        const rangeX = maxX - minX;
        minY -= rangeY * 0.05;
        maxY += rangeY * 0.05;
        
        // 绘制背景和坐标轴
        this.drawBackground(margin);
        
        // 计算数据到屏幕的映射比例
        const scaleX = plotWidth / (maxX - minX);
        const scaleY = plotHeight / (maxY - minY);
        
        // 计算可见数据范围
        const visibleMinX = minX + this.spectrumPanOffsetX / (scaleX * this.spectrumZoomLevelX);
        const visibleMaxX = visibleMinX + (plotWidth / scaleX) / this.spectrumZoomLevelX;
        
        const visibleMinY = minY + this.spectrumPanOffsetY / (scaleY * this.spectrumZoomLevelY);
        const visibleMaxY = visibleMinY + (plotHeight / scaleY) / this.spectrumZoomLevelY;
        
        // 绘制坐标轴刻度和网格线
        this.drawAxesAndGrid(margin, minX, maxX, minY, maxY, visibleMinX, visibleMaxX, visibleMinY, visibleMaxY, data);
        
        // 绘制光谱线
        this.drawSpectrumLine(margin, validData, minX, maxX, minY, maxY);
        
        // 显示当前缩放级别
        this.showZoomLevel(margin);
    }
    
    // 绘制背景
    drawBackground(margin) {
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // 绘制整个画布背景
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 绘制绘图区域背景
        this.ctx.fillStyle = '#1e1e1e';
        this.ctx.fillRect(margin.left, margin.top, plotWidth, plotHeight);
        
        // 绘制边框
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(margin.left, margin.top, plotWidth, plotHeight);
    }
    
    // 绘制坐标轴刻度和网格线
    drawAxesAndGrid(margin, minX, maxX, minY, maxY, visibleMinX, visibleMaxX, visibleMinY, visibleMaxY, data) {
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // 绘制X轴网格线和刻度
        const xTicks = 8;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'top';
        this.ctx.font = '12px Arial';
        
        // 计算合适的刻度间隔
        const xRange = visibleMaxX - visibleMinX;
        const xStep = calculateNiceStep(xRange / xTicks);
        const xStart = Math.ceil(visibleMinX / xStep) * xStep;
        
        // 存储已绘制的刻度位置，避免重叠
        const drawnXPositions = [];
        const minXDistance = 60;
        
        for (let x = xStart; x <= visibleMaxX; x += xStep) {
            // 计算屏幕坐标
            const screenX = margin.left + ((x - visibleMinX) * plotWidth / (visibleMaxX - visibleMinX));
            
            // 检查是否与已绘制的刻度太近
            let tooClose = false;
            for (const pos of drawnXPositions) {
                if (Math.abs(screenX - pos) < minXDistance) {
                    tooClose = true;
                    break;
                }
            }
            
            // 如果在可见区域内且不会导致刻度重叠
            if (screenX >= margin.left && screenX <= this.canvas.width - margin.right && !tooClose) {
                // 绘制网格线
                this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                this.ctx.beginPath();
                this.ctx.moveTo(screenX, margin.top);
                this.ctx.lineTo(screenX, this.canvas.height - margin.bottom);
                this.ctx.stroke();
                
                // 绘制刻度
                this.ctx.fillStyle = 'white';
                this.ctx.fillText(x.toFixed(1), screenX, this.canvas.height - margin.bottom + 10);
                
                // 记录已绘制的位置
                drawnXPositions.push(screenX);
            }
        }
        
        // 绘制Y轴网格线和刻度
        const yTicks = 8;
        this.ctx.textAlign = 'right';
        this.ctx.textBaseline = 'middle';
        
        // 计算合适的刻度间隔
        const yRange = visibleMaxY - visibleMinY;
        const yStep = calculateNiceStep(yRange / yTicks);
        const yStart = Math.ceil(visibleMinY / yStep) * yStep;
        
        // 存储已绘制的刻度位置，避免重叠
        const drawnYPositions = [];
        const minYDistance = 30;
        
        for (let y = yStart; y <= visibleMaxY; y += yStep) {
            // 计算屏幕坐标
            const screenY = margin.top + plotHeight - ((y - visibleMinY) * plotHeight / (visibleMaxY - visibleMinY));
            
            // 检查是否与已绘制的刻度太近
            let tooClose = false;
            for (const pos of drawnYPositions) {
                if (Math.abs(screenY - pos) < minYDistance) {
                    tooClose = true;
                    break;
                }
            }
            
            // 如果在可见区域内且不会导致刻度重叠
            if (screenY >= margin.top && screenY <= this.canvas.height - margin.bottom && !tooClose) {
                // 绘制网格线
                this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                this.ctx.beginPath();
                this.ctx.moveTo(margin.left, screenY);
                this.ctx.lineTo(this.canvas.width - margin.right, screenY);
                this.ctx.stroke();
                
                // 绘制刻度
                this.ctx.fillStyle = 'white';
                const formattedValue = Math.abs(y) > 1000 || Math.abs(y) < 0.01 ? y.toExponential(1) : y.toFixed(1);
                this.ctx.fillText(formattedValue, margin.left - 10, screenY);
                
                // 记录已绘制的位置
                drawnYPositions.push(screenY);
            }
        }
        
        // 绘制坐标轴标签
        this.ctx.font = '14px Arial';
        this.ctx.fillStyle = 'white';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(`Wavelength (${data.wavelengthUnit || 'Å'})`, this.canvas.width / 2, this.canvas.height - margin.bottom / 3);
        
        this.ctx.save();
        this.ctx.translate(margin.left / 3, this.canvas.height / 2);
        this.ctx.rotate(-Math.PI / 2);
        this.ctx.fillText(`Flux (${data.fluxUnit || 'Counts'})`, 0, 0);
        this.ctx.restore();
    }
    
    // 绘制光谱线
    drawSpectrumLine(margin, validData, minX, maxX, minY, maxY) {
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // 保存当前上下文状态
        this.ctx.save();
        
        // 创建裁剪区域，确保绘制不超出绘图区域
        this.ctx.beginPath();
        this.ctx.rect(margin.left, margin.top, plotWidth, plotHeight);
        this.ctx.clip();
        
        // 计算可见数据范围
        const visibleMinX = minX + this.spectrumPanOffsetX / (plotWidth / (maxX - minX) * this.spectrumZoomLevelX);
        const visibleMaxX = visibleMinX + plotWidth / (plotWidth / (maxX - minX) * this.spectrumZoomLevelX);
        const visibleMinY = minY + this.spectrumPanOffsetY / (plotHeight / (maxY - minY) * this.spectrumZoomLevelY);
        const visibleMaxY = visibleMinY + plotHeight / (plotHeight / (maxY - minY) * this.spectrumZoomLevelY);
        
        // 找到可见范围内的数据点
        const visiblePoints = validData.filter(point => 
            point.x >= visibleMinX && point.x <= visibleMaxX
        );
        
        if (visiblePoints.length === 0) return;
        
        // 绘制光谱线 - 直接连接点，不进行插值
        this.ctx.beginPath();
        this.ctx.strokeStyle = '#4a9eff';
        this.ctx.lineWidth = 1.5;
        
        // 从第一个可见点开始绘制
        const firstPoint = visiblePoints[0];
        const firstX = margin.left + ((firstPoint.x - visibleMinX) * plotWidth / (visibleMaxX - visibleMinX));
        const firstY = this.canvas.height - margin.bottom - ((firstPoint.y - visibleMinY) * plotHeight / (visibleMaxY - visibleMinY));
        this.ctx.moveTo(firstX, firstY);
        
        // 绘制所有可见点
        for (let i = 1; i < visiblePoints.length; i++) {
            const point = visiblePoints[i];
            const x = margin.left + ((point.x - visibleMinX) * plotWidth / (visibleMaxX - visibleMinX));
            const y = this.canvas.height - margin.bottom - ((point.y - visibleMinY) * plotHeight / (visibleMaxY - visibleMinY));
            this.ctx.lineTo(x, y);
        }
        
        this.ctx.stroke();
        
        // 恢复上下文状态
        this.ctx.restore();
    }
    
    // 显示当前缩放级别
    showZoomLevel(margin) {
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        this.ctx.fillText(`Zoom X: ${(this.spectrumZoomLevelX * 100).toFixed(0)}% Y: ${(this.spectrumZoomLevelY * 100).toFixed(0)}%`, margin.left + 10, margin.top + 10);
    }
    
    // 更新列选择器
    updateColumnSelectors(columns, defaultWavelength, defaultFlux) {
        // 清空选择器
        this.wavelengthSelector.innerHTML = '<option value="">未选择</option>';
        this.fluxSelector.innerHTML = '<option value="">未选择</option>';
        
        // 填充选项
        columns.forEach((column, index) => {
            const name = column.name || `列 ${index}`;
            const value = column.name || index.toString();
            
            // 添加到波长选择器
            const wOption = document.createElement('option');
            wOption.value = value;
            wOption.textContent = name;
            this.wavelengthSelector.appendChild(wOption);
            
            // 添加到流量选择器
            const fOption = document.createElement('option');
            fOption.value = value;
            fOption.textContent = name;
            this.fluxSelector.appendChild(fOption);
        });
        
        // 设置默认选中项
        if (defaultWavelength) {
            this.wavelengthSelector.value = defaultWavelength;
            this.selectedWavelengthColumn = defaultWavelength;
        }
        
        if (defaultFlux) {
            this.fluxSelector.value = defaultFlux;
            this.selectedFluxColumn = defaultFlux;
        }
    }
    
    // 根据选择的列更新光谱
    updateSpectrumWithSelectedColumns() {
        if (!this.availableColumns.length) return;
        
        const spectrumData = this.canvas.dataset.spectrumData;
        if (!spectrumData) return;
        
        const data = JSON.parse(spectrumData);
        if (!data || !data.wavelength || !data.flux) return;
        
        // 向扩展发送更新光谱的请求
        vscode.postMessage({
            command: 'updateSpectrum',
            wavelengthColumn: this.selectedWavelengthColumn,
            fluxColumn: this.selectedFluxColumn,
            data: data
        });
        
        // 重置缩放和平移状态
        this.spectrumZoomLevelX = 1.0;
        this.spectrumZoomLevelY = 1.0;
        this.spectrumPanOffsetX = 0;
        this.spectrumPanOffsetY = 0;
    }
}

// 导出光谱查看器类
export default SpectrumViewer; 