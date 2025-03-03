import { vscode, log, updateStatusInfo, showZoomIndicator } from './common.js';

// 图像查看器类
class ImageViewer {
    constructor() {
        // 图像相关变量
        this.currentImageData = null;      // 当前显示的图像数据
        this.originalImageData = null;     // 原始图像数据（用于多维数据）
        this.zoomLevel = 1.0;             // 当前缩放级别
        this.panOffsetX = 0;              // X轴平移偏移量
        this.panOffsetY = 0;              // Y轴平移偏移量
        this.isDragging = false;          // 是否正在拖动
        this.dragStartX = 0;              // 拖动开始时的X坐标
        this.dragStartY = 0;              // 拖动开始时的Y坐标
        this.lastPanOffsetX = 0;          // 上次平移的X偏移量
        this.lastPanOffsetY = 0;          // 上次平移的Y偏移量
        
        // 多维数据相关变量
        this.currentChannel = 0;          // 当前显示的通道索引
        this.maxChannel = 0;              // 最大通道数
        this.currentAxesOrder = [0, 1, 2]; // 当前轴顺序 [深度,高度,宽度]
        
        // DOM元素
        this.canvas = document.getElementById('fits-canvas');           // 主画布元素
        this.ctx = this.canvas.getContext('2d');                       // 主画布上下文
        this.imageContainer = document.querySelector('.image-container'); // 图像容器元素
        this.zoomIndicator = document.getElementById('zoom-indicator');   // 缩放指示器元素
        this.channelSlider = document.getElementById('channel-slider');   // 通道选择滑块
        this.channelValue = document.getElementById('channel-value');     // 通道值显示元素
        this.axesOrderSelector = document.getElementById('axes-order-selector'); // 轴顺序选择器
        
        // 初始化事件监听
        this.initEventListeners();
    }
    
    // 初始化事件监听器
    initEventListeners() {
        // 图像容器的鼠标滚轮事件 - 缩放
        this.imageContainer.addEventListener('wheel', this.handleWheel.bind(this));
        
        // 图像容器的鼠标按下事件 - 开始拖动
        this.imageContainer.addEventListener('mousedown', this.handleMouseDown.bind(this));
        
        // 图像容器的鼠标移动事件 - 拖动和显示像素值
        this.imageContainer.addEventListener('mousemove', this.handleMouseMove.bind(this));
        
        // 图像容器的鼠标离开事件
        this.imageContainer.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
        
        // 窗口的鼠标抬起事件 - 结束拖动
        window.addEventListener('mouseup', this.handleMouseUp.bind(this));
        
        // 通道滑块事件
        if (this.channelSlider) {
            this.channelSlider.addEventListener('input', this.handleChannelSliderInput.bind(this));
        }
        
        // 轴顺序选择器事件
        if (this.axesOrderSelector) {
            this.axesOrderSelector.addEventListener('change', this.handleAxesOrderChange.bind(this));
        }
        
        // 创建ResizeObserver监听容器大小变化
        this.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.target === this.imageContainer) {
                    this.handleContainerResize(entry.contentRect);
                }
            }
        });
        
        // 开始观察容器大小变化
        this.resizeObserver.observe(this.imageContainer);
    }
    
    // 处理容器大小变化
    handleContainerResize(contentRect) {
        if (!this.currentImageData) return;
        
        const newWidth = contentRect.width;
        const newHeight = contentRect.height;
        
        // 保存当前的缩放和平移状态
        const prevZoomLevel = this.zoomLevel;
        const prevPanOffsetX = this.panOffsetX;
        const prevPanOffsetY = this.panOffsetY;
        const prevWidth = this.canvas.width;
        const prevHeight = this.canvas.height;
        
        // 更新canvas大小
        this.canvas.width = newWidth;
        this.canvas.height = newHeight;
        
        // 如果用户没有手动缩放，则更新缩放级别
        const autoZoomLevel = Math.min(prevWidth / this.currentImageData.width, prevHeight / this.currentImageData.height) * 0.95;
        if (Math.abs(prevZoomLevel - autoZoomLevel) < 0.01) {
            const scaleX = newWidth / this.currentImageData.width;
            const scaleY = newHeight / this.currentImageData.height;
            this.zoomLevel = Math.min(scaleX, scaleY) * 0.95;
            this.zoomLevel = Math.max(this.zoomLevel, 0.1);
            
            // 居中图像
            this.panOffsetX = (newWidth - this.currentImageData.width * this.zoomLevel) / 2;
            this.panOffsetY = (newHeight - this.currentImageData.height * this.zoomLevel) / 2;
        } else {
            // 用户已手动缩放，保持相对位置
            this.panOffsetX = prevPanOffsetX + (newWidth - prevWidth) / 2;
            this.panOffsetY = prevPanOffsetY + (newHeight - prevHeight) / 2;
        }
        
        // 更新缩放指示器文本
        this.zoomIndicator.textContent = `缩放: ${Math.round(this.zoomLevel * 100)}%`;
        
        // 重新渲染图像
        this.renderWithTransform();
    }
    
    // 处理鼠标滚轮事件
    handleWheel(event) {
        event.preventDefault();
        
        if (!this.currentImageData) return;
        
        // 获取鼠标在Canvas上的位置
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        // 计算鼠标位置在图像上的坐标（缩放前）
        const imageX = (mouseX - this.panOffsetX) / this.zoomLevel;
        const imageY = (mouseY - this.panOffsetY) / this.zoomLevel;
        
        // 计算缩放因子
        const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
        let newZoomLevel = Math.max(0.1, Math.min(2000, this.zoomLevel * zoomFactor));
        
        // 防止缩放值过大导致渲染问题
        if (!isFinite(newZoomLevel) || newZoomLevel <= 0) {
            newZoomLevel = 1.0;
        }
        
        // 更新缩放级别
        this.zoomLevel = newZoomLevel;
        
        // 计算新的偏移量，使鼠标指向的点保持在相同位置
        this.panOffsetX = mouseX - imageX * this.zoomLevel;
        this.panOffsetY = mouseY - imageY * this.zoomLevel;
        
        // 更新缩放指示器
        showZoomIndicator(this.zoomIndicator, this.zoomLevel);
        
        // 重新渲染图像
        this.renderWithTransform();
    }
    
    // 处理鼠标按下事件
    handleMouseDown(event) {
        if (!this.currentImageData || event.button !== 0) return;
        
        this.isDragging = true;
        this.dragStartX = event.clientX;
        this.dragStartY = event.clientY;
        this.lastPanOffsetX = this.panOffsetX;
        this.lastPanOffsetY = this.panOffsetY;
        
        // 改变鼠标样式
        this.imageContainer.style.cursor = 'grabbing';
    }
    
    // 处理鼠标移动事件
    handleMouseMove(event) {
        if (!this.currentImageData) return;
        
        // 获取Canvas的位置和尺寸
        const rect = this.canvas.getBoundingClientRect();
        
        // 处理拖动
        if (this.isDragging) {
            const deltaX = event.clientX - this.dragStartX;
            const deltaY = event.clientY - this.dragStartY;
            
            // 直接更新平移偏移量，不进行边界检查
            this.panOffsetX = this.lastPanOffsetX + deltaX;
            this.panOffsetY = this.lastPanOffsetY + deltaY;
            
            // 重新渲染图像
            this.renderWithTransform();
            return;
        }
        
        // 检查鼠标是否在Canvas上
        if (event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom) {
            
            // 计算Canvas上的坐标
            const canvasX = event.clientX - rect.left;
            const canvasY = event.clientY - rect.top;
            
            // 计算图像上的坐标（考虑缩放和平移）
            const imageX = Math.floor((canvasX - this.panOffsetX) / this.zoomLevel);
            const imageY = Math.floor((canvasY - this.panOffsetY) / this.zoomLevel);
            
            // 确保坐标在图像范围内
            if (imageX >= 0 && imageX < this.currentImageData.width && 
                imageY >= 0 && imageY < this.currentImageData.height) {
                // 更新坐标显示
                document.getElementById('image-coords-x').textContent = imageX;
                document.getElementById('image-coords-y').textContent = imageY;
                
                // 获取像素值
                const pixelIndex = imageY * this.currentImageData.width + imageX;
                
                // 直接显示原始像素值
                if (pixelIndex >= 0 && pixelIndex < this.currentImageData.data.length) {
                    const rawValue = this.currentImageData.data[pixelIndex];
                    document.getElementById('pixel-value').textContent = rawValue.toString();
                }
                
                // 发送坐标到扩展获取WCS坐标
                vscode.postMessage({
                    command: 'getPixelValue',
                    x: imageX,
                    y: imageY
                });
            }
        }
    }
    
    // 处理鼠标抬起事件
    handleMouseUp() {
        if (this.isDragging) {
            this.isDragging = false;
            this.imageContainer.style.cursor = 'default';
        }
    }
    
    // 处理鼠标离开事件
    handleMouseLeave() {
        document.getElementById('pixel-info').style.display = 'none';
    }
    
    // 处理通道滑块输入
    handleChannelSliderInput() {
        this.currentChannel = parseInt(this.channelSlider.value);
        this.channelValue.textContent = `${this.currentChannel}/${this.maxChannel}`;
        this.updateChannelDisplay();
    }
    
    // 处理轴顺序变更
    handleAxesOrderChange() {
        this.currentAxesOrder = this.axesOrderSelector.value.split(',').map(Number);
        log(`轴顺序已更改为: ${this.currentAxesOrder}`);
        
        // 重置通道滑块
        this.resetChannelSlider();
        
        // 更新显示
        this.updateChannelDisplay();
    }
    
    // 重置通道滑块
    resetChannelSlider() {
        if (!this.originalImageData) return;
        
        // 根据当前轴顺序确定通道维度的大小
        const channelDimIndex = this.currentAxesOrder[0];
        
        // 获取通道维度的大小
        let channelDimSize = 1;
        if (channelDimIndex === 0 && this.originalImageData.depth) {
            channelDimSize = this.originalImageData.depth;
        } else if (channelDimIndex === 1 && this.originalImageData.height) {
            channelDimSize = this.originalImageData.height;
        } else if (channelDimIndex === 2 && this.originalImageData.width) {
            channelDimSize = this.originalImageData.width;
        }
        
        // 更新滑块范围
        this.maxChannel = Math.max(0, channelDimSize - 1);
        this.channelSlider.max = this.maxChannel;
        
        // 重置当前通道
        this.currentChannel = 0;
        this.channelSlider.value = this.currentChannel;
        this.channelValue.textContent = `${this.currentChannel}/${this.maxChannel}`;
    }
    
    // 更新通道显示
    updateChannelDisplay() {
        if (!this.originalImageData) return;
        
        // 提取当前通道的2D切片
        const slice2D = this.extract2DSlice(this.originalImageData, this.currentChannel, this.currentAxesOrder);
        
        // 更新当前图像数据
        this.currentImageData = slice2D;
        
        // 重新渲染图像
        this.renderWithTransform();
    }
    
    // 从3D数据中提取2D切片
    extract2DSlice(data3D, channel, axesOrder) {
        if (!data3D || !data3D.data3D) return data3D;
        
        const channelDimIndex = axesOrder[0];
        const rowDimIndex = axesOrder[1];
        const colDimIndex = axesOrder[2];
        
        // 获取各维度大小
        const dims = [
            data3D.depth || 1,
            data3D.height || 1,
            data3D.width || 1
        ];
        
        // 计算结果2D切片的尺寸
        const resultWidth = dims[colDimIndex];
        const resultHeight = dims[rowDimIndex];
        
        // 创建结果数据
        const result = {
            data: new Float32Array(resultWidth * resultHeight),
            width: resultWidth,
            height: resultHeight,
            min: Infinity,
            max: -Infinity
        };
        
        // 填充2D切片数据
        for (let r = 0; r < resultHeight; r++) {
            for (let c = 0; c < resultWidth; c++) {
                // 计算原始3D数据中的索引
                const indices = [0, 0, 0];
                indices[channelDimIndex] = channel;
                indices[rowDimIndex] = r;
                indices[colDimIndex] = c;
                
                const srcIdx = indices[0] * dims[1] * dims[2] + indices[1] * dims[2] + indices[2];
                const destIdx = r * resultWidth + c;
                
                // 复制数据
                result.data[destIdx] = data3D.data3D[srcIdx];
                
                // 更新最小/最大值
                result.min = Math.min(result.min, result.data[destIdx]);
                result.max = Math.max(result.max, result.data[destIdx]);
            }
        }
        
        return result;
    }
    
    // 使用变换渲染图像
    renderWithTransform() {
        if (!this.currentImageData) return;
        
        // 清除Canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 设置Canvas尺寸为容器尺寸
        const container = this.imageContainer;
        this.canvas.width = container.clientWidth;
        this.canvas.height = container.clientHeight;
        
        // 绘制图像（应用缩放和平移）
        this.ctx.save();
        
        // 确保变换矩阵不会导致数值溢出
        if (isFinite(this.panOffsetX) && isFinite(this.panOffsetY) && 
            isFinite(this.zoomLevel) && this.zoomLevel > 0) {
            
            // 应用变换
            this.ctx.translate(this.panOffsetX, this.panOffsetY);
            this.ctx.scale(this.zoomLevel, this.zoomLevel);
            
            // 检查图像大小，如果超过阈值，则使用分块处理
            const isLargeImage = this.currentImageData.width * this.currentImageData.height > 4000000;
            
            if (isLargeImage) {
                this.renderLargeImageWithChunks();
            } else {
                this.renderStandardImage();
            }
            
        } else {
            // 如果出现无效值，重置变换
            this.zoomLevel = 1.0;
            this.panOffsetX = (this.canvas.width - this.currentImageData.width) / 2;
            this.panOffsetY = (this.canvas.height - this.currentImageData.height) / 2;
            this.ctx.translate(this.panOffsetX, this.panOffsetY);
            this.ctx.scale(this.zoomLevel, this.zoomLevel);
            
            // 渲染图像
            if (this.currentImageData.width * this.currentImageData.height > 4000000) {
                this.renderLargeImageWithChunks();
            } else {
                this.renderStandardImage();
            }
        }
        
        this.ctx.restore();
        
        // 更新状态信息
        updateStatusInfo(this.currentImageData, this.zoomLevel);
    }
    
    // 标准图像渲染方法
    renderStandardImage() {
        // 创建ImageData对象
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.currentImageData.width;
        tempCanvas.height = this.currentImageData.height;
        const tempCtx = tempCanvas.getContext('2d');
        const imageData = tempCtx.createImageData(this.currentImageData.width, this.currentImageData.height);
        
        // 计算缩放因子
        const scale = 255 / (this.currentImageData.max - this.currentImageData.min);
        
        try {
            // 使用 TypedArray 和向量化操作处理图像数据
            const pixelCount = this.currentImageData.width * this.currentImageData.height;
            const rgbaData = new Uint8ClampedArray(pixelCount * 4);
            
            // 向量化处理 - 一次性计算所有像素值
            for (let i = 0; i < pixelCount; i++) {
                // 计算缩放后的灰度值
                const scaledValue = Math.max(0, Math.min(255, Math.round((this.currentImageData.data[i] - this.currentImageData.min) * scale)));
                
                // 设置 RGBA 值 (灰度图像，R=G=B)
                const idx = i * 4;
                rgbaData[idx] = scaledValue;     // R
                rgbaData[idx + 1] = scaledValue; // G
                rgbaData[idx + 2] = scaledValue; // B
                rgbaData[idx + 3] = 255;         // A
            }
            
            // 直接设置 imageData 的数据
            imageData.data.set(rgbaData);
            
            // 将ImageData绘制到临时Canvas
            tempCtx.putImageData(imageData, 0, 0);
            
            // 将临时Canvas绘制到主Canvas
            this.ctx.drawImage(tempCanvas, 0, 0);
            
        } catch (error) {
            log(`渲染图像时出错: ${error.message}`);
            document.getElementById('image-placeholder').textContent = `渲染图像时出错: ${error.message}`;
        }
    }
    
    // 分块渲染大图像
    renderLargeImageWithChunks() {
        try {
            // 计算缩放因子
            const scale = 255 / (this.currentImageData.max - this.currentImageData.min);
            
            // 创建临时Canvas
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.currentImageData.width;
            tempCanvas.height = this.currentImageData.height;
            const tempCtx = tempCanvas.getContext('2d');
            
            // 分块处理整个图像
            const chunkSize = 1000; // 每块的像素行数
            
            // 创建整个图像的ImageData
            const fullImageData = tempCtx.createImageData(this.currentImageData.width, this.currentImageData.height);
            const fullData = new Uint8ClampedArray(this.currentImageData.width * this.currentImageData.height * 4);
            
            // 分块处理
            for (let startY = 0; startY < this.currentImageData.height; startY += chunkSize) {
                const endY = Math.min(startY + chunkSize, this.currentImageData.height);
                const chunkHeight = endY - startY;
                
                // 处理当前块的像素
                for (let y = startY; y < endY; y++) {
                    const rowOffset = y * this.currentImageData.width;
                    
                    for (let x = 0; x < this.currentImageData.width; x++) {
                        const srcIdx = rowOffset + x;
                        const destIdx = srcIdx * 4;
                        
                        // 计算缩放后的灰度值
                        const scaledValue = Math.max(0, Math.min(255, Math.round((this.currentImageData.data[srcIdx] - this.currentImageData.min) * scale)));
                        
                        // 设置 RGBA 值
                        fullData[destIdx] = scaledValue;     // R
                        fullData[destIdx + 1] = scaledValue; // G
                        fullData[destIdx + 2] = scaledValue; // B
                        fullData[destIdx + 3] = 255;         // A
                    }
                }
            }
            
            // 设置ImageData
            fullImageData.data.set(fullData);
            
            // 将ImageData绘制到临时Canvas
            tempCtx.putImageData(fullImageData, 0, 0);
            
            // 将临时Canvas绘制到主Canvas，使用原始尺寸
            this.ctx.drawImage(tempCanvas, 0, 0);
            
        } catch (error) {
            log(`分块渲染图像时出错: ${error.message}`);
            document.getElementById('image-placeholder').textContent = `渲染图像时出错: ${error.message}`;
        }
    }
    
    // 加载图像数据
    loadImageData(rawData, prevZoomLevel, prevPanOffsetX, prevPanOffsetY, prevWidth, prevHeight) {
        if (!rawData || !rawData.data || !rawData.width || !rawData.height) {
            log('图像数据无效');
            return;
        }
        
        // 检查是否是多维数据
        const isMultiDimensional = rawData.depth && rawData.depth > 1;
        
        // 如果是多维数据，保存原始数据并显示通道选择器
        if (isMultiDimensional) {
            // 保存原始多维数据
            this.originalImageData = {
                data3D: rawData.data,
                width: rawData.width,
                height: rawData.height,
                depth: rawData.depth,
                min: rawData.min,
                max: rawData.max
            };
            
            // 显示通道选择器
            document.getElementById('channel-selector-container').style.display = 'block';
            
            // 确保轴顺序选择器的值与currentAxesOrder一致
            if (this.axesOrderSelector.value !== this.currentAxesOrder.join(',')) {
                this.axesOrderSelector.value = this.currentAxesOrder.join(',');
            }
            
            // 重置通道滑块
            this.resetChannelSlider();
            
            // 提取第一个通道的2D切片
            const slice2D = this.extract2DSlice(this.originalImageData, this.currentChannel, this.currentAxesOrder);
            
            // 更新当前图像数据
            this.currentImageData = slice2D;
        } else {
            // 隐藏通道选择器
            document.getElementById('channel-selector-container').style.display = 'none';
            
            // 清除原始多维数据
            this.originalImageData = null;
            
            // 保存当前图像数据
            this.currentImageData = rawData;
        }
        
        // 显示Canvas，隐藏占位符
        this.canvas.style.display = 'block';
        document.getElementById('image-placeholder').style.display = 'none';
        
        // 确保canvas大小与容器大小一致
        const container = this.imageContainer;
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        // 如果canvas大小与容器大小不一致，则更新canvas大小
        if (this.canvas.width !== containerWidth || this.canvas.height !== containerHeight) {
            this.canvas.width = containerWidth;
            this.canvas.height = containerHeight;
        }
        
        // 如果是首次加载或图像尺寸变化，则重置视图
        if (!prevZoomLevel || !prevWidth || !prevHeight || 
            prevWidth !== this.currentImageData.width || prevHeight !== this.currentImageData.height) {
            // 重置缩放和平移
            this.zoomLevel = 1.0;
            this.panOffsetX = 0;
            this.panOffsetY = 0;
            
            // 计算初始缩放级别，使图像适应容器
            const scaleX = containerWidth / this.currentImageData.width;
            const scaleY = containerHeight / this.currentImageData.height;
            this.zoomLevel = Math.min(scaleX, scaleY) * 0.95;
            
            // 确保缩放级别不会太小
            this.zoomLevel = Math.max(this.zoomLevel, 0.1);
            
            // 居中图像
            this.panOffsetX = (containerWidth - this.currentImageData.width * this.zoomLevel) / 2;
            this.panOffsetY = (containerHeight - this.currentImageData.height * this.zoomLevel) / 2;
        } else {
            // 保持之前的缩放和平移状态
            this.zoomLevel = prevZoomLevel;
            this.panOffsetX = prevPanOffsetX;
            this.panOffsetY = prevPanOffsetY;
        }
        
        // 更新缩放指示器
        showZoomIndicator(this.zoomIndicator, this.zoomLevel);
        
        // 渲染图像
        this.renderWithTransform();
        
        // 发送就绪消息
        vscode.postMessage({
            command: 'viewerReady'
        });
    }
    
    // 从二进制文件加载图像数据
    async loadImageDataFromFile(fileUri, prevZoomLevel, prevPanOffsetX, prevPanOffsetY, prevWidth, prevHeight) {
        try {
            document.getElementById('image-placeholder').textContent = 'Loading image data...';
            
            // 获取二进制数据
            const response = await fetch(fileUri);
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            
            // 读取头部长度
            const headerLengthView = new DataView(arrayBuffer, 0, 4);
            const headerLength = headerLengthView.getUint32(0, true); // 小端字节序
            
            // 读取元数据
            const metadataBytes = new Uint8Array(arrayBuffer, 4, headerLength);
            const metadataJson = new TextDecoder().decode(metadataBytes);
            const metadata = JSON.parse(metadataJson);
            
            // 读取图像数据
            const dataStart = 4 + headerLength;
            const dataBuffer = arrayBuffer.slice(dataStart);
            const imageData = new Float32Array(dataBuffer);
            
            // 创建完整的数据对象
            const rawData = {
                data: imageData,
                width: metadata.width,
                height: metadata.height,
                min: metadata.min,
                max: metadata.max
            };
            
            // 如果有深度信息，添加到数据对象
            if (metadata.depth) {
                rawData.depth = metadata.depth;
            }
            
            // 加载图像数据
            this.loadImageData(rawData, prevZoomLevel, prevPanOffsetX, prevPanOffsetY, prevWidth, prevHeight);
            
        } catch (error) {
            log(`加载图像数据文件时出错: ${error.message}`);
            document.getElementById('image-placeholder').textContent = `加载图像数据文件时出错: ${error.message}`;
            this.canvas.style.display = 'none';
            document.getElementById('image-placeholder').style.display = 'block';
        }
    }
}

// 导出图像查看器类
export default ImageViewer; 