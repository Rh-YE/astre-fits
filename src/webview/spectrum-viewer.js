import { vscode, log, calculateNiceStep, findClosestDataPoint } from './common.js';

// Spectrum viewer class | 光谱查看器类
class SpectrumViewer {
    constructor() {
        // Spectrum data related variables | 光谱数据相关变量
        this.currentSpectrumData = null;
        this.availableColumns = [];
        this.selectedWavelengthColumn = "";
        this.selectedFluxColumn = "";
        
        // Zoom and pan related variables | 缩放和平移相关变量
        this.spectrumZoomLevelX = 1.0;  // X-axis zoom level | X轴缩放级别
        this.spectrumZoomLevelY = 1.0;  // Y-axis zoom level | Y轴缩放级别
        this.spectrumPanOffsetX = 0;
        this.spectrumPanOffsetY = 0;
        this.spectrumIsDragging = false;
        this.spectrumDragStartX = 0;
        this.spectrumDragStartY = 0;
        this.spectrumLastPanOffsetX = 0;
        this.spectrumLastPanOffsetY = 0;
        
        // Zoom box related variables | 放大框相关变量
        this.isZoomBoxMode = false;
        this.isDrawingZoomBox = false;
        this.zoomBoxStartX = 0;
        this.zoomBoxStartY = 0;
        this.zoomBoxEndX = 0;
        this.zoomBoxEndY = 0;
        this.zoomBoxElement = null;
        
        // DOM elements | DOM元素
        this.canvas = document.getElementById('spectrum-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.container = document.querySelector('.image-container');
        this.wavelengthSelector = document.getElementById('wavelength-column-selector');
        this.fluxSelector = document.getElementById('flux-column-selector');
        this.zoomBoxButton = document.getElementById('zoom-box-button');
        
        // Create crosshair overlay | 创建辅助线叠加层
        this.crosshairOverlay = document.createElement('canvas');
        this.crosshairOverlay.style.position = 'absolute';
        this.crosshairOverlay.style.top = '0';
        this.crosshairOverlay.style.left = '0';
        this.crosshairOverlay.style.pointerEvents = 'none';
        this.crosshairOverlay.style.zIndex = '10';
        this.container.appendChild(this.crosshairOverlay);
        
        // Create zoom box element | 创建矩形框元素
        this.zoomBoxElement = document.createElement('div');
        this.zoomBoxElement.style.position = 'absolute';
        this.zoomBoxElement.style.border = '2px dashed yellow';
        this.zoomBoxElement.style.backgroundColor = 'rgba(255, 255, 0, 0.1)';
        this.zoomBoxElement.style.pointerEvents = 'none';
        this.zoomBoxElement.style.display = 'none';
        this.zoomBoxElement.style.zIndex = '1000';
        this.container.appendChild(this.zoomBoxElement);
        
        // Initialize event listeners | 初始化事件监听
        this.initEventListeners();
    }    
    // Initialize event listeners | 初始化事件监听器
    initEventListeners() {
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this)); // Spectrum wheel zoom | 光谱滚轮缩放
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this)); // Local zoom button click | 局部放大开启按钮单击
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this)); // Spectrum Canvas mouse move - drag, draw box and show values | 光谱Canvas的鼠标移动事件 - 拖动、绘制矩形框和显示值
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave.bind(this));  // Spectrum Canvas mouse leave - clear crosshair | 光谱Canvas的鼠标离开事件 - 清除辅助线
        window.addEventListener('mouseup', this.handleMouseUp.bind(this)); // Window mouse up - end drag or box selection | 窗口的鼠标抬起事件 - 结束拖动或矩形框选择
        
        if (this.zoomBoxButton) {
            this.zoomBoxButton.addEventListener('click', this.handleZoomBoxButtonClick.bind(this)); // Zoom button click event | 放大按钮点击事件
        }
        
        // Column selector change events | 列选择器变更事件
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
    
    // Handle zoom button click | 处理放大按钮点击
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
    
    // Update zoom box position | 更新矩形框位置
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
    
    // Handle mouse wheel event | 处理鼠标滚轮事件
    handleWheel(event) {
        event.preventDefault();
        
        const spectrumData = this.canvas.dataset.spectrumData;
        if (!spectrumData) return;
        
        // Get current spectrum data | 获取当前光谱数据
        const data = JSON.parse(spectrumData);
        if (!data || !data.wavelength || !data.flux) return;
        
        // Calculate zoom factor | 计算缩放因子
        const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
        
        // Set margins | 设置边距
        const margin = { top: 40, right: 40, bottom: 60, left: 70 };
        
        // Get plot area dimensions | 获取绘图区域的尺寸
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // Get mouse position on Canvas | 获取鼠标在Canvas上的位置
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        // Determine zoom behavior based on modifier keys | 根据按键修饰符决定缩放行为
        let newZoomLevelX = this.spectrumZoomLevelX;
        let newZoomLevelY = this.spectrumZoomLevelY;
        
        if (event.shiftKey) {
            // Only zoom Y axis | 仅缩放 Y 轴
            newZoomLevelY = Math.max(0.1, Math.min(50, this.spectrumZoomLevelY * zoomFactor));
        } else if (event.ctrlKey || event.metaKey) {
            // Only zoom X axis | 仅缩放 X 轴
            newZoomLevelX = Math.max(0.1, Math.min(50, this.spectrumZoomLevelX * zoomFactor));
        } else {
            // Zoom both axes | 同时缩放两个轴
            newZoomLevelX = Math.max(0.1, Math.min(50, this.spectrumZoomLevelX * zoomFactor));
            newZoomLevelY = Math.max(0.1, Math.min(50, this.spectrumZoomLevelY * zoomFactor));
        }
        
        // Only zoom when mouse is in plot area | 只有当鼠标在绘图区域内时才进行缩放
        if (mouseX >= margin.left && mouseX <= (this.canvas.width - margin.right) &&
            mouseY >= margin.top && mouseY <= (this.canvas.height - margin.bottom)) {
            
            // Calculate data range | 计算数据范围
            let minX = data.wavelength[0];
            let maxX = data.wavelength[0];
            let minY = data.flux[0];
            let maxY = data.flux[0];
            
            // Use loop instead of spread operator for better performance | 使用循环代替展开操作符，提高性能
            for (let i = 0; i < data.wavelength.length; i++) {
                const x = data.wavelength[i];
                const y = data.flux[i];
                if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) {
                    minX = x < minX ? x : minX;
                    maxX = x > maxX ? x : maxX;
                    minY = y < minY ? y : minY;
                    maxY = y > maxY ? y : maxY;
                }
            }
            // Calculate data to screen mapping ratio | 计算数据到屏幕的映射比例
            const scaleX = plotWidth / (maxX - minX);
            const scaleY = plotHeight / (maxY - minY);
            
            // Calculate current visible data range | 计算当前可见数据范围
            const visibleMinX = minX + this.spectrumPanOffsetX / (scaleX * this.spectrumZoomLevelX);
            const visibleMinY = minY + this.spectrumPanOffsetY / (scaleY * this.spectrumZoomLevelY);
            
            // Calculate data coordinates at mouse position | 计算鼠标位置对应的数据坐标
            const mouseDataX = visibleMinX + (mouseX - margin.left) / (scaleX * this.spectrumZoomLevelX);
            const mouseDataY = visibleMinY + (this.canvas.height - margin.bottom - mouseY) / (scaleY * this.spectrumZoomLevelY);
            
            // Update zoom levels | 更新缩放级别
            this.spectrumZoomLevelX = newZoomLevelX;
            this.spectrumZoomLevelY = newZoomLevelY;
            
            // Calculate new pan offset to keep mouse position fixed | 计算新的平移偏移，保持鼠标位置不变
            this.spectrumPanOffsetX = (mouseDataX - minX) * scaleX * this.spectrumZoomLevelX - (mouseX - margin.left);
            this.spectrumPanOffsetY = (mouseDataY - minY) * scaleY * this.spectrumZoomLevelY - (this.canvas.height - margin.bottom - mouseY);
            
            // Optimize rendering using requestAnimationFrame | 使用requestAnimationFrame优化渲染
            if (this._wheelAnimationFrame) {
                cancelAnimationFrame(this._wheelAnimationFrame);
            }
            
            this._wheelAnimationFrame = requestAnimationFrame(() => {
                this.renderSpectrum(data, true);
                this._wheelAnimationFrame = null;
            });
        }
    }
    
    // Handle mouse down event | 处理鼠标按下事件
    handleMouseDown(event) {
        if (event.button !== 0) return; // Only handle left button | 只处理左键
        
        // Get Canvas position and dimensions | 获取Canvas的位置和尺寸
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        // Set margins | 设置边距
        const margin = { top: 40, right: 40, bottom: 60, left: 70 };
        
        // Check if mouse is in plot area | 检查是否在绘图区域内
        if (mouseX >= margin.left && mouseX <= (this.canvas.width - margin.right) &&
            mouseY >= margin.top && mouseY <= (this.canvas.height - margin.bottom)) {
            
            if (this.isZoomBoxMode) {
                // Start drawing rectangle box | 开始绘制矩形框
                this.isDrawingZoomBox = true;
                this.zoomBoxStartX = mouseX;
                this.zoomBoxStartY = mouseY;
                this.zoomBoxEndX = mouseX;
                this.zoomBoxEndY = mouseY;
                
                // Show rectangle box | 显示矩形框
                this.updateZoomBoxPosition();
                this.zoomBoxElement.style.display = 'block';
            } else {
                // Normal drag behavior | 正常拖动行为
                this.spectrumIsDragging = true;
                this.spectrumDragStartX = event.clientX;
                this.spectrumDragStartY = event.clientY;
                this.spectrumLastPanOffsetX = this.spectrumPanOffsetX;
                this.spectrumLastPanOffsetY = this.spectrumPanOffsetY;
                
                // Change cursor style | 改变鼠标样式
                this.canvas.style.cursor = 'grabbing';
            }
        }
    }
    
    // Handle mouse move event | 处理鼠标移动事件
    handleMouseMove(event) {
        // 使用节流控制更新频率
        if (this._throttleTimeout) return;
        this._throttleTimeout = setTimeout(() => {
            this._throttleTimeout = null;
        }, 16); // 约60fps的更新频率

        const rect = this.canvas.getBoundingClientRect();
        
        // Handle rectangle box drawing | 处理矩形框绘制
        if (this.isDrawingZoomBox) {
            this.zoomBoxEndX = event.clientX - rect.left;
            this.zoomBoxEndY = event.clientY - rect.top;
            this.updateZoomBoxPosition();
            return;
        }
        
        // Handle dragging | 处理拖动
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

        // Check if mouse is over Canvas | 检查鼠标是否在Canvas上
        if (event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom) {
            
            const spectrumData = this.canvas.dataset.spectrumData;
            if (!spectrumData) return;
            
            const data = JSON.parse(spectrumData);
            if (!data || !data.wavelength || !data.flux) return;
            
            // Calculate coordinates on Canvas | 计算Canvas上的坐标
            const canvasX = event.clientX - rect.left;
            const canvasY = event.clientY - rect.top;
            
            // Set margins | 设置边距
            const margin = { top: 40, right: 40, bottom: 60, left: 70 };
            
            // Check if within plot area | 检查是否在绘图区域内
            if (canvasX >= margin.left && canvasX <= (this.canvas.width - margin.right) &&
                canvasY >= margin.top && canvasY <= (this.canvas.height - margin.bottom)) {
                
                // Calculate data range | 计算数据范围
                let minX = data.wavelength[0];
                let maxX = data.wavelength[0];
                let minY = data.flux[0];
                let maxY = data.flux[0];
                
                // 使用循环代替展开操作符，提高性能
                for (let i = 0; i < data.wavelength.length; i++) {
                    const x = data.wavelength[i];
                    const y = data.flux[i];
                    if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) {
                        minX = x < minX ? x : minX;
                        maxX = x > maxX ? x : maxX;
                        minY = y < minY ? y : minY;
                        maxY = y > maxY ? y : maxY;
                    }
                }
                
                // Add padding to data range | 添加padding到数据范围
                const rangeY = maxY - minY;
                const paddedMinY = minY - rangeY * 0.05;
                const paddedMaxY = maxY + rangeY * 0.05;
                
                // Calculate visible data range considering zoom and pan | 计算可见数据范围，考虑缩放和平移
                const plotWidth = this.canvas.width - margin.left - margin.right;
                const plotHeight = this.canvas.height - margin.top - margin.bottom;
                const scaleX = plotWidth / (maxX - minX);
                const scaleY = plotHeight / (paddedMaxY - paddedMinY);
                
                const visibleMinX = minX + this.spectrumPanOffsetX / (scaleX * this.spectrumZoomLevelX);
                const visibleMaxX = visibleMinX + (plotWidth / scaleX) / this.spectrumZoomLevelX;
                const visibleMinY = paddedMinY + this.spectrumPanOffsetY / (scaleY * this.spectrumZoomLevelY);
                const visibleMaxY = visibleMinY + (plotHeight / scaleY) / this.spectrumZoomLevelY;
                
                // Calculate mouse position in data coordinates | 计算鼠标在数据坐标系中的位置
                const mouseDataX = visibleMinX + ((canvasX - margin.left) / plotWidth) * (visibleMaxX - visibleMinX);
                
                // 使用二分查找找到最近的数据点
                const findClosestPointIndex = (target, arr) => {
                    let left = 0;
                    let right = arr.length - 1;
                    
                    while (left <= right) {
                        const mid = Math.floor((left + right) / 2);
                        if (arr[mid] === target) return mid;
                        
                        if (arr[mid] < target) {
                            left = mid + 1;
                        } else {
                            right = mid - 1;
                        }
                    }
                    
                    // 找到最近的点
                    if (left >= arr.length) return right;
                    if (right < 0) return left;
                    
                    const leftDiff = Math.abs(arr[right] - target);
                    const rightDiff = Math.abs(arr[left] - target);
                    
                    return leftDiff < rightDiff ? right : left;
                };
                
                // 找到最近的数据点
                let closestIndex;
                
                if (canvasX <= margin.left) {
                    // 如果鼠标在绘图区域左侧，选择第一个可见点
                    closestIndex = 0;
                    while (closestIndex < data.wavelength.length && 
                           (isNaN(data.wavelength[closestIndex]) || 
                            !isFinite(data.wavelength[closestIndex]) ||
                            data.wavelength[closestIndex] < visibleMinX)) {
                        closestIndex++;
                    }
                } else if (canvasX >= this.canvas.width - margin.right) {
                    // 如果鼠标在绘图区域右侧，选择最后一个可见点
                    closestIndex = data.wavelength.length - 1;
                    while (closestIndex >= 0 && 
                           (isNaN(data.wavelength[closestIndex]) || 
                            !isFinite(data.wavelength[closestIndex]) ||
                            data.wavelength[closestIndex] > visibleMaxX)) {
                        closestIndex--;
                    }
                } else {
                    // 使用二分查找找到最近的点
                    closestIndex = findClosestPointIndex(mouseDataX, data.wavelength);
                }
                
                if (closestIndex >= 0 && closestIndex < data.wavelength.length) {
                    const closestPoint = {
                        x: data.wavelength[closestIndex],
                        y: data.flux[closestIndex]
                    };
                    
                    // 计算屏幕坐标
                    const pointX = margin.left + ((closestPoint.x - visibleMinX) / (visibleMaxX - visibleMinX)) * plotWidth;
                    const pointY = this.canvas.height - margin.bottom - 
                                 ((closestPoint.y - visibleMinY) / (visibleMaxY - visibleMinY)) * plotHeight;
                    
                    // 更新坐标和值显示
                    document.getElementById('image-coords-x').textContent = closestPoint.x.toFixed(2);
                    document.getElementById('image-coords-y').textContent = closestPoint.y.toFixed(2);
                    document.getElementById('pixel-value').textContent = closestPoint.y.toString();
                    
                    // 使用requestAnimationFrame优化绘制
                    if (this._crosshairAnimationFrame) {
                        cancelAnimationFrame(this._crosshairAnimationFrame);
                    }
                    
                    this._crosshairAnimationFrame = requestAnimationFrame(() => {
                        this.drawCrosshair(pointX, pointY);
                        this._crosshairAnimationFrame = null;
                    });
                }
            } else {
                this.clearCrosshair();
            }
        }
    }
    
    // Handle mouse up event | 处理鼠标抬起事件
    handleMouseUp() {
        if (this.spectrumIsDragging) {
            this.spectrumIsDragging = false;
            this.canvas.style.cursor = 'default';
        }
        
        if (this.isDrawingZoomBox) {
            this.isDrawingZoomBox = false;
            
            // Hide zoom box | 隐藏矩形框
            this.zoomBoxElement.style.display = 'none';
            
            // Get zoom box position and size (screen coordinates) | 获取矩形框的位置和尺寸（屏幕坐标）
            const left = Math.min(this.zoomBoxStartX, this.zoomBoxEndX);
            const top = Math.min(this.zoomBoxStartY, this.zoomBoxEndY);
            const width = Math.abs(this.zoomBoxEndX - this.zoomBoxStartX);
            const height = Math.abs(this.zoomBoxEndY - this.zoomBoxStartY);
            
            // If zoom box is too small, don't zoom | 如果矩形框太小，不执行放大操作
            if (width < 10 || height < 10) {
                return;
            }
            
            // Get spectrum data | 获取光谱数据
            const spectrumData = this.canvas.dataset.spectrumData;
            if (!spectrumData) return;
            
            const data = JSON.parse(spectrumData);
            if (!data || !data.wavelength || !data.flux) return;
            
            // Set margins | 设置边距
            const margin = { top: 40, right: 40, bottom: 60, left: 70 };
            const plotWidth = this.canvas.width - margin.left - margin.right;
            const plotHeight = this.canvas.height - margin.top - margin.bottom;
            
            // Optimize data range calculation | 优化数据范围计算
            let minX = data.wavelength[0];
            let maxX = data.wavelength[0];
            let minY = data.flux[0];
            let maxY = data.flux[0];
            
            for (let i = 0; i < data.wavelength.length; i++) {
                const x = data.wavelength[i];
                const y = data.flux[i];
                if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) {
                    minX = x < minX ? x : minX;
                    maxX = x > maxX ? x : maxX;
                    minY = y < minY ? y : minY;
                    maxY = y > maxY ? y : maxY;
                }
            }
            
            // Ensure zoom box is within plot area | 确保矩形框在绘图区域内
            const adjustedLeft = Math.max(left, margin.left);
            const adjustedRight = Math.min(left + width, this.canvas.width - margin.right);
            const adjustedTop = Math.max(top, margin.top);
            const adjustedBottom = Math.min(top + height, this.canvas.height - margin.bottom);
            
            // Calculate data to screen mapping ratio | 计算数据到屏幕的映射比例
            const scaleX = plotWidth / (maxX - minX);
            const scaleY = plotHeight / (maxY - minY);
            
            // Calculate current visible data range | 计算当前可见数据范围
            const visibleMinX = minX + this.spectrumPanOffsetX / (scaleX * this.spectrumZoomLevelX);
            const visibleMinY = minY + this.spectrumPanOffsetY / (scaleY * this.spectrumZoomLevelY);
            
            // Convert screen coordinates to data coordinates | 将屏幕坐标转换为数据坐标
            const boxMinX = visibleMinX + (adjustedLeft - margin.left) / (scaleX * this.spectrumZoomLevelX);
            const boxMaxX = visibleMinX + (adjustedRight - margin.left) / (scaleX * this.spectrumZoomLevelX);
            const boxMinY = visibleMinY + (this.canvas.height - adjustedBottom - margin.bottom) / (scaleY * this.spectrumZoomLevelY);
            const boxMaxY = visibleMinY + (this.canvas.height - adjustedTop - margin.bottom) / (scaleY * this.spectrumZoomLevelY);
            
            // Calculate new zoom level considering max and min zoom limits | 计算新的缩放级别，考虑最大和最小缩放限制
            const boxWidthX = boxMaxX - boxMinX;
            const boxWidthY = boxMaxY - boxMinY;
            const boxCenterX = (boxMinX + boxMaxX) / 2;
            const boxCenterY = (boxMinY + boxMaxY) / 2;
            
            // Limit maximum zoom level to prevent excessive zoom | 限制最大缩放级别，防止过度放大
            const maxZoomLevel = 1000;
            const newZoomLevelX = Math.min(maxZoomLevel, (maxX - minX) / boxWidthX * this.spectrumZoomLevelX);
            const newZoomLevelY = Math.min(maxZoomLevel, (maxY - minY) / boxWidthY * this.spectrumZoomLevelY);
            
            // Calculate new pan offset | 计算新的平移偏移
            const newPanOffsetX = (boxCenterX - minX - boxWidthX / 2) * scaleX * newZoomLevelX;
            const newPanOffsetY = (boxCenterY - minY - boxWidthY / 2) * scaleY * newZoomLevelY;
            
            // Update zoom and pan state | 更新缩放和平移状态
            this.spectrumZoomLevelX = newZoomLevelX;
            this.spectrumZoomLevelY = newZoomLevelY;
            this.spectrumPanOffsetX = newPanOffsetX;
            this.spectrumPanOffsetY = newPanOffsetY;
            
            // Use requestAnimationFrame to optimize rendering | 使用requestAnimationFrame优化渲染
            requestAnimationFrame(() => {
                this.renderSpectrum(data, true);
            });
            
            // If zoom mode is one-time, auto disable it | 如果放大模式是一次性的，自动关闭放大模式
            if (this.isZoomBoxMode) {
                this.isZoomBoxMode = false;
                this.zoomBoxButton.style.backgroundColor = 'var(--vscode-button-background)';
                this.zoomBoxButton.textContent = '放大';
                this.canvas.style.cursor = 'default';
            }
        }
    }
    
    // Handle mouse leave event | 处理鼠标离开事件
    handleMouseLeave() {
        this.clearCrosshair();
    }
    
    // 清除光谱十字准线
    clearCrosshair() {
        const ctx = this.crosshairOverlay.getContext('2d');
        ctx.clearRect(0, 0, this.crosshairOverlay.width, this.crosshairOverlay.height);
    }
    
    // Draw spectrum crosshair | 绘制光谱十字准线
    drawCrosshair(x, y) {
        // Adjust overlay size to match container | 调整叠加层大小以匹配容器
        this.crosshairOverlay.width = this.container.clientWidth;
        this.crosshairOverlay.height = this.container.clientHeight;
        
        const ctx = this.crosshairOverlay.getContext('2d');
        const margin = { top: 40, right: 40, bottom: 60, left: 70 };
        
        // Clear previous guidelines | 清除之前的辅助线
        ctx.clearRect(0, 0, this.crosshairOverlay.width, this.crosshairOverlay.height);
        
        // Check if coordinates are within plot area | 检查坐标是否在绘图区域内
        if (x < margin.left || x > (this.canvas.width - margin.right) ||
            y < margin.top || y > (this.canvas.height - margin.bottom)) {
            return;
        }
        
        // Set guideline style | 设置辅助线样式
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        
        // Draw horizontal guideline | 绘制水平辅助线
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(this.canvas.width - margin.right, y);
        ctx.stroke();
        
        // Draw vertical guideline | 绘制垂直辅助线
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, this.canvas.height - margin.bottom);
        ctx.stroke();
        
        // Draw a small circle at intersection | 在交叉点绘制一个小圆圈
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255, 255, 0, 0.9)';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    
    // Render spectrum | 渲染光谱
    renderSpectrum(data, update = false) {
        if (!data || !data.wavelength || !data.flux || 
            !Array.isArray(data.wavelength) || !Array.isArray(data.flux) || 
            data.wavelength.length === 0 || data.flux.length === 0) {
            log('Invalid spectrum data | 无效的光谱数据');
            return;
        }

        if (data.wavelength.length !== data.flux.length) {
            log(`Data length mismatch: flux=${data.flux.length}, wavelength=${data.wavelength.length} | 数据长度不匹配`);
            return;
        }

        // Save spectrum data to canvas dataset for mouse events | 保存光谱数据到Canvas的dataset属性，以便鼠标移动事件使用
        this.canvas.dataset.spectrumData = JSON.stringify(data);
        
        // Ensure canvas size matches container | 确保canvas大小与容器大小一致
        const container = this.container;
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        // Update canvas size if different from container | 如果canvas大小与容器大小不一致，则更新canvas大小
        if (this.canvas.width !== containerWidth || this.canvas.height !== containerHeight) {
            this.canvas.width = containerWidth;
            this.canvas.height = containerHeight;
        }
        
        // Skip resetting zoom and pan state if updating | 如果是更新模式，不需要重置缩放和平移状态
        if (!update) {
            // Reset zoom and pan state | 重置缩放和平移状态
            this.spectrumZoomLevelX = 1.0;
            this.spectrumZoomLevelY = 1.0;
            this.spectrumPanOffsetX = 0;
            this.spectrumPanOffsetY = 0;
        }
        
        // Clear canvas | 清空画布
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Optimize data range calculation | 优化数据范围计算
        let minY = data.flux[0];
        let maxY = data.flux[0];
        let minX = data.wavelength[0];
        let maxX = data.wavelength[0];

        // Use loop instead of spread operator for better performance | 使用循环代替展开操作符，提高性能
        for (let i = 0; i < data.wavelength.length; i++) {
            const x = data.wavelength[i];
            const y = data.flux[i];
            if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) {
                minX = x < minX ? x : minX;
                maxX = x > maxX ? x : maxX;
                minY = y < minY ? y : minY;
                maxY = y > maxY ? y : maxY;
            }
        }

        // Set margins | 设置边距
        const margin = { top: 40, right: 40, bottom: 60, left: 70 };
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // Add padding to data range | 添加一些padding到数据范围
        const rangeY = maxY - minY;
        minY -= rangeY * 0.05;
        maxY += rangeY * 0.05;
        
        // Draw background and axes | 绘制背景和坐标轴
        this.drawBackground(margin);
        
        // Calculate data to screen mapping ratio | 计算数据到屏幕的映射比例
        const scaleX = plotWidth / (maxX - minX);
        const scaleY = plotHeight / (maxY - minY);
        
        // Calculate visible data range | 计算可见数据范围
        const visibleMinX = minX + this.spectrumPanOffsetX / (scaleX * this.spectrumZoomLevelX);
        const visibleMaxX = visibleMinX + (plotWidth / scaleX) / this.spectrumZoomLevelX;
        const visibleMinY = minY + this.spectrumPanOffsetY / (scaleY * this.spectrumZoomLevelY);
        const visibleMaxY = visibleMinY + (plotHeight / scaleY) / this.spectrumZoomLevelY;
        
        // Draw axes, grid and spectrum line | 绘制坐标轴刻度和网格线
        this.drawAxesAndGrid(margin, minX, maxX, minY, maxY, visibleMinX, visibleMaxX, visibleMinY, visibleMaxY, data);
        this.drawSpectrumLine(margin, data, minX, maxX, minY, maxY, visibleMinX, visibleMaxX);
        
        // Show current zoom level | 显示当前缩放级别
        this.showZoomLevel(margin);
    }
    
    // Draw background | 绘制背景
    drawBackground(margin) {
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // Draw entire canvas background | 绘制整个画布背景
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw plot area background | 绘制绘图区域背景
        this.ctx.fillStyle = '#1e1e1e';
        this.ctx.fillRect(margin.left, margin.top, plotWidth, plotHeight);
        
        // Draw border | 绘制边框
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(margin.left, margin.top, plotWidth, plotHeight);
    }
    
    // Draw axes and grid | 绘制坐标轴刻度和网格线
    drawAxesAndGrid(margin, minX, maxX, minY, maxY, visibleMinX, visibleMaxX, visibleMinY, visibleMaxY, data) {
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // Draw X axis grid lines and ticks | 绘制X轴网格线和刻度
        const xTicks = 8;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'top';
        this.ctx.font = '12px Arial';
        
        // Calculate appropriate tick interval | 计算合适的刻度间隔
        const xRange = visibleMaxX - visibleMinX;
        const xStep = calculateNiceStep(xRange / xTicks);
        const xStart = Math.ceil(visibleMinX / xStep) * xStep;
        
        // Store drawn tick positions to avoid overlap | 存储已绘制的刻度位置，避免重叠
        const drawnXPositions = [];
        const minXDistance = 60;
        
        for (let x = xStart; x <= visibleMaxX; x += xStep) {
            // Calculate screen coordinates | 计算屏幕坐标
            const screenX = margin.left + ((x - visibleMinX) * plotWidth / (visibleMaxX - visibleMinX));
            
            // Check if too close to existing ticks | 检查是否与已绘制的刻度太近
            let tooClose = false;
            for (const pos of drawnXPositions) {
                if (Math.abs(screenX - pos) < minXDistance) {
                    tooClose = true;
                    break;
                }
            }
            
            // Draw if visible and not overlapping | 如果在可见区域内且不会导致刻度重叠
            if (screenX >= margin.left && screenX <= this.canvas.width - margin.right && !tooClose) {
                // Draw grid line | 绘制网格线
                this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                this.ctx.beginPath();
                this.ctx.moveTo(screenX, margin.top);
                this.ctx.lineTo(screenX, this.canvas.height - margin.bottom);
                this.ctx.stroke();
                
                // Draw tick | 绘制刻度
                this.ctx.fillStyle = 'white';
                this.ctx.fillText(x.toFixed(1), screenX, this.canvas.height - margin.bottom + 10);
                
                // Record drawn position | 记录已绘制的位置
                drawnXPositions.push(screenX);
            }
        }
        
        // Draw Y axis grid lines and ticks | 绘制Y轴网格线和刻度
        const yTicks = 8;
        this.ctx.textAlign = 'right';
        this.ctx.textBaseline = 'middle';
        
        // Calculate appropriate tick interval | 计算合适的刻度间隔
        const yRange = visibleMaxY - visibleMinY;
        const yStep = calculateNiceStep(yRange / yTicks);
        const yStart = Math.ceil(visibleMinY / yStep) * yStep;
        
        // Store drawn tick positions to avoid overlap | 存储已绘制的刻度位置，避免重叠
        const drawnYPositions = [];
        const minYDistance = 30;
        
        for (let y = yStart; y <= visibleMaxY; y += yStep) {
            // Calculate screen coordinates | 计算屏幕坐标
            const screenY = margin.top + plotHeight - ((y - visibleMinY) * plotHeight / (visibleMaxY - visibleMinY));
            
            // Check if too close to existing ticks | 检查是否与已绘制的刻度太近
            let tooClose = false;
            for (const pos of drawnYPositions) {
                if (Math.abs(screenY - pos) < minYDistance) {
                    tooClose = true;
                    break;
                }
            }
            
            // Draw if visible and not overlapping | 如果在可见区域内且不会导致刻度重叠
            if (screenY >= margin.top && screenY <= this.canvas.height - margin.bottom && !tooClose) {
                // Draw grid line | 绘制网格线
                this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                this.ctx.beginPath();
                this.ctx.moveTo(margin.left, screenY);
                this.ctx.lineTo(this.canvas.width - margin.right, screenY);
                this.ctx.stroke();
                
                // Draw tick | 绘制刻度
                this.ctx.fillStyle = 'white';
                const formattedValue = Math.abs(y) > 1000 || Math.abs(y) < 0.01 ? y.toExponential(1) : y.toFixed(1);
                this.ctx.fillText(formattedValue, margin.left - 10, screenY);
                
                // Record drawn position | 记录已绘制的位置
                drawnYPositions.push(screenY);
            }
        }
        
        // Draw axis labels | 绘制坐标轴标签
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
    
    // Optimize spectrum line drawing method | 优化光谱线绘制方法
    drawSpectrumLine(margin, data, minX, maxX, minY, maxY, visibleMinX, visibleMaxX) {
        const plotWidth = this.canvas.width - margin.left - margin.right;
        const plotHeight = this.canvas.height - margin.top - margin.bottom;
        
        // Save current context state | 保存当前上下文状态
        this.ctx.save();
        
        // Create clipping region to ensure drawing stays within plot area | 创建裁剪区域，确保绘制不超出绘图区域
        this.ctx.beginPath();
        this.ctx.rect(margin.left, margin.top, plotWidth, plotHeight);
        this.ctx.clip();
        
        // Calculate visible data range | 计算可见数据范围
        const visibleMinY = minY + this.spectrumPanOffsetY / (plotHeight / (maxY - minY) * this.spectrumZoomLevelY);
        const visibleMaxY = visibleMinY + plotHeight / (plotHeight / (maxY - minY) * this.spectrumZoomLevelY);
        
        // Calculate data point stride based on screen resolution | 计算数据点的步长，根据屏幕分辨率优化
        const pixelRatio = window.devicePixelRatio || 1;
        const minPointSpacing = 1 / pixelRatio;
        const dataPointSpacing = (visibleMaxX - visibleMinX) / plotWidth;
        const stride = Math.max(1, Math.floor(dataPointSpacing / minPointSpacing));
        
        // Find start and end indices for visible range | 找到可见范围内的起始和结束索引
        let startIdx = 0;
        let endIdx = data.wavelength.length;
        
        // 使用二分查找找到起始索引
        let left = 0;
        let right = data.wavelength.length - 1;
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (data.wavelength[mid] < visibleMinX) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }
        startIdx = Math.max(0, left - 1);
        
        // 使用二分查找找到结束索引
        left = 0;
        right = data.wavelength.length - 1;
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (data.wavelength[mid] <= visibleMaxX) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }
        endIdx = Math.min(data.wavelength.length, right + 2);
        
        // Draw spectrum line | 绘制光谱线
        this.ctx.beginPath();
        this.ctx.strokeStyle = '#4a9eff';
        this.ctx.lineWidth = 1.5;
        
        let isFirstPoint = true;
        
        // Use optimized drawing logic | 使用优化的绘制逻辑
        for (let i = startIdx; i < endIdx; i += stride) {
            const x = data.wavelength[i];
            const y = data.flux[i];
            
            if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) {
                const screenX = margin.left + ((x - visibleMinX) * plotWidth / (visibleMaxX - visibleMinX));
                const screenY = this.canvas.height - margin.bottom - ((y - visibleMinY) * plotHeight / (visibleMaxY - visibleMinY));
                
                if (isFirstPoint) {
                    this.ctx.moveTo(screenX, screenY);
                    isFirstPoint = false;
                } else {
                    this.ctx.lineTo(screenX, screenY);
                }
            }
        }
        
        this.ctx.stroke();
        this.ctx.restore();
    }
    
    // Show current zoom level | 显示当前缩放级别
    showZoomLevel(margin) {
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        this.ctx.fillText(`Zoom X: ${(this.spectrumZoomLevelX * 100).toFixed(0)}% Y: ${(this.spectrumZoomLevelY * 100).toFixed(0)}%`, margin.left + 10, margin.top + 10);
    }
    
    // Update column selectors | 更新列选择器
    updateColumnSelectors(columns, defaultWavelength, defaultFlux) {
        // Clear selectors | 清空选择器
        this.wavelengthSelector.innerHTML = '<option value="">未选择</option>';
        this.fluxSelector.innerHTML = '<option value="">未选择</option>';
        
        // Fill options | 填充选项
        columns.forEach((column, index) => {
            const name = column.name || `列 ${index}`;
            const value = column.name || index.toString();
            
            // Add to wavelength selector | 添加到波长选择器
            const wOption = document.createElement('option');
            wOption.value = value;
            wOption.textContent = name;
            this.wavelengthSelector.appendChild(wOption);
            
            // Add to flux selector | 添加到流量选择器
            const fOption = document.createElement('option');
            fOption.value = value;
            fOption.textContent = name;
            this.fluxSelector.appendChild(fOption);
        });
        
        // Set default selections | 设置默认选中项
        if (defaultWavelength) {
            this.wavelengthSelector.value = defaultWavelength;
            this.selectedWavelengthColumn = defaultWavelength;
        }
        
        if (defaultFlux) {
            this.fluxSelector.value = defaultFlux;
            this.selectedFluxColumn = defaultFlux;
        }
    }
    
    // Update spectrum with selected columns | 根据选择的列更新光谱
    updateSpectrumWithSelectedColumns() {
        if (!this.availableColumns.length) return;
        
        const spectrumData = this.canvas.dataset.spectrumData;
        if (!spectrumData) return;
        
        const data = JSON.parse(spectrumData);
        if (!data || !data.wavelength || !data.flux) return;
        
        // Send update spectrum request to extension | 向扩展发送更新光谱的请求
        vscode.postMessage({
            command: 'updateSpectrum',
            wavelengthColumn: this.selectedWavelengthColumn,
            fluxColumn: this.selectedFluxColumn,
            data: data
        });
        // Reset zoom and pan state | 重置缩放和平移状态
        this.spectrumZoomLevelX = 1.0;
        this.spectrumZoomLevelY = 1.0;
        this.spectrumPanOffsetX = 0;
        this.spectrumPanOffsetY = 0;
    }
}

// Export spectrum viewer class | 导出光谱查看器类
export default SpectrumViewer;
