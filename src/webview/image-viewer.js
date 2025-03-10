import { vscode, log, updateStatusInfo, showZoomIndicator } from './common.js';

// Image viewer class | 图像查看器类
class ImageViewer {
    constructor() {
        // Image related variables | 图像相关变量
        this.currentImageData = null;      // Current displayed image data | 当前显示的图像数据
        this.originalImageData = null;     // Original image data (for multi-dimensional data) | 原始图像数据（用于多维数据）
        this.zoomLevel = 1.0;             // Current zoom level | 当前缩放级别
        this.panOffsetX = 0;              // X-axis pan offset | X轴平移偏移量
        this.panOffsetY = 0;              // Y-axis pan offset | Y轴平移偏移量
        this.isDragging = false;          // Whether currently dragging | 是否正在拖动
        this.dragStartX = 0;              // X coordinate at drag start | 拖动开始时的X坐标
        this.dragStartY = 0;              // Y coordinate at drag start | 拖动开始时的Y坐标
        this.lastPanOffsetX = 0;          // Last X pan offset | 上次平移的X偏移量
        this.lastPanOffsetY = 0;          // Last Y pan offset | 上次平移的Y偏移量
        
        // Display control variables | 显示控制变量
        this.biasValue = 0.5;             // Bias value | 偏差值
        this.contrastValue = 1.0;         // Contrast value | 对比度值
        
        // Multi-dimensional data related variables | 多维数据相关变量
        this.currentChannel = 0;          // Current channel index | 当前显示的通道索引
        this.maxChannel = 0;              // Maximum number of channels | 最大通道数
        this.currentAxesOrder = [0, 1, 2]; // Current axes order [depth,height,width] | 当前轴顺序 [深度,高度,宽度]
        
        // DOM elements | DOM元素
        this.canvas = document.getElementById('fits-canvas');           // Main canvas element | 主画布元素
        this.ctx = this.canvas.getContext('2d');                       // Main canvas context | 主画布上下文
        this.imageContainer = document.querySelector('.image-container'); // Image container element | 图像容器元素
        this.zoomIndicator = document.getElementById('zoom-indicator');   // Zoom indicator element | 缩放指示器元素
        this.channelSlider = document.getElementById('channel-slider');   // Channel selection slider | 通道选择滑块
        this.channelValue = document.getElementById('channel-value');     // Channel value display element | 通道值显示元素
        this.axesOrderSelector = document.getElementById('axes-order-selector'); // Axes order selector | 轴顺序选择器
        
        // Get bias and contrast elements | 获取偏差和对比度元素
        this.biasSlider = document.getElementById('bias-slider');
        this.contrastSlider = document.getElementById('contrast-slider');
        this.biasValueDisplay = document.getElementById('bias-value');
        this.contrastValueDisplay = document.getElementById('contrast-value');
        
        // Scale type related variables | 缩放类型相关变量
        this.useZScale = false;           // Whether to use zscale | 是否使用zscale
        this.currentScaleType = 'linear'; // Current scale type | 当前缩放类型
        
        // Get scale type elements | 获取缩放类型元素
        this.minmaxButton = document.getElementById('minmax-button');
        this.zscaleButton = document.getElementById('zscale-button');
        this.scaleTypeButtons = document.querySelectorAll('.scale-type-button');
        
        this.isMultiDimensional = false;  // 添加多维数据标记
        
        // Initialize event listeners | 初始化事件监听
        this.initEventListeners();

        // Add cleanup method
        this.cleanup = this.cleanup.bind(this);
        window.addEventListener('beforeunload', this.cleanup);
    }
    
    // Initialize event listeners | 初始化事件监听器
    initEventListeners() {
        // Mouse wheel event for image container - zooming | 图像容器的鼠标滚轮事件 - 缩放
        this.imageContainer.addEventListener('wheel', this.handleWheel.bind(this));
        
        // Mouse down event for image container - start dragging | 图像容器的鼠标按下事件 - 开始拖动
        this.imageContainer.addEventListener('mousedown', this.handleMouseDown.bind(this));
        
        // Mouse move event for image container - dragging and pixel value display | 图像容器的鼠标移动事件 - 拖动和显示像素值
        this.imageContainer.addEventListener('mousemove', this.handleMouseMove.bind(this));
        
        // Mouse leave event for image container | 图像容器的鼠标离开事件
        this.imageContainer.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
        
        // Mouse up event for window - end dragging | 窗口的鼠标抬起事件 - 结束拖动
        window.addEventListener('mouseup', this.handleMouseUp.bind(this));
        
        // Channel slider event | 通道滑块事件
        if (this.channelSlider) {
            this.channelSlider.addEventListener('input', this.handleChannelSliderInput.bind(this));
        }
        
        // Axes order selector event | 轴顺序选择器事件
        if (this.axesOrderSelector) {
            this.axesOrderSelector.addEventListener('change', this.handleAxesOrderChange.bind(this));
        }
        
        // Bias and contrast slider events | 偏差和对比度滑块事件
        if (this.biasSlider) {
            this.biasSlider.addEventListener('input', this.handleBiasSliderInput.bind(this));
        }
        
        if (this.contrastSlider) {
            this.contrastSlider.addEventListener('input', this.handleContrastSliderInput.bind(this));
        }
        
        // Create ResizeObserver to monitor container size changes | 创建ResizeObserver监听容器大小变化
        this.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.target === this.imageContainer) {
                    this.handleContainerResize(entry.contentRect);
                }
            }
        });
        
        // Start observing container size changes | 开始观察容器大小变化
        this.resizeObserver.observe(this.imageContainer);
        
        // Scale type button events | 缩放类型按钮事件
        if (this.minmaxButton) {
            this.minmaxButton.addEventListener('click', () => {
                this.useZScale = false;
                this.minmaxButton.classList.add('active');
                this.zscaleButton.classList.remove('active');
                // 使用本地变换而不是发送到后端
                this.applyCurrentTransformToSlice();
            });
        }
        
        if (this.zscaleButton) {
            this.zscaleButton.addEventListener('click', () => {
                this.useZScale = true;
                this.zscaleButton.classList.add('active');
                this.minmaxButton.classList.remove('active');
                // 使用本地变换而不是发送到后端
                this.applyCurrentTransformToSlice();
            });
        }
        
        // Scale type buttons events | 缩放类型按钮事件
        this.scaleTypeButtons.forEach(button => {
            button.addEventListener('click', () => {
                this.scaleTypeButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                this.currentScaleType = button.dataset.scaleType;
                // 使用本地变换而不是发送到后端
                this.applyCurrentTransformToSlice();
            });
        });
    }
    
    // Handle container size changes | 处理容器大小变化
    handleContainerResize(contentRect) {
        if (!this.currentImageData) return;
        
        const newWidth = contentRect.width;
        const newHeight = contentRect.height;
        
        // Save current zoom and pan state | 保存当前的缩放和平移状态
        const prevZoomLevel = this.zoomLevel;
        const prevPanOffsetX = this.panOffsetX;
        const prevPanOffsetY = this.panOffsetY;
        const prevWidth = this.canvas.width;
        const prevHeight = this.canvas.height;
        
        // Update canvas size | 更新canvas大小
        this.canvas.width = newWidth;
        this.canvas.height = newHeight;
        
        // Update zoom level if user hasn't manually zoomed | 如果用户没有手动缩放，则更新缩放级别
        const autoZoomLevel = Math.min(prevWidth / this.currentImageData.width, prevHeight / this.currentImageData.height) * 0.95;
        if (Math.abs(prevZoomLevel - autoZoomLevel) < 0.01) {
            const scaleX = newWidth / this.currentImageData.width;
            const scaleY = newHeight / this.currentImageData.height;
            this.zoomLevel = Math.min(scaleX, scaleY) * 0.95;
            this.zoomLevel = Math.max(this.zoomLevel, 0.1);
            
            // Center the image | 居中图像
            this.panOffsetX = (newWidth - this.currentImageData.width * this.zoomLevel) / 2;
            this.panOffsetY = (newHeight - this.currentImageData.height * this.zoomLevel) / 2;
        } else {
            // User has manually zoomed, maintain relative position | 用户已手动缩放，保持相对位置
            this.panOffsetX = prevPanOffsetX + (newWidth - prevWidth) / 2;
            this.panOffsetY = prevPanOffsetY + (newHeight - prevHeight) / 2;
        }
        
        // Update zoom indicator text | 更新缩放指示器文本
        this.zoomIndicator.textContent = `Zoom: ${Math.round(this.zoomLevel * 100)}%`;
        
        // Re-render image | 重新渲染图像
        this.renderWithTransform();
    }
    
    // Handle mouse wheel event | 处理鼠标滚轮事件
    handleWheel(event) {
        event.preventDefault();
        
        if (!this.currentImageData) return;
        
        // Get mouse position on Canvas | 获取鼠标在Canvas上的位置
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        // Calculate mouse coordinates on image (before zoom) | 计算鼠标位置在图像上的坐标（缩放前）
        const imageX = (mouseX - this.panOffsetX) / this.zoomLevel;
        const imageY = (mouseY - this.panOffsetY) / this.zoomLevel;
        
        // Calculate zoom factor | 计算缩放因子
        const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
        let newZoomLevel = Math.max(0.1, Math.min(2000, this.zoomLevel * zoomFactor));
        
        // Prevent rendering issues from excessive zoom values | 防止缩放值过大导致渲染问题
        if (!isFinite(newZoomLevel) || newZoomLevel <= 0) {
            newZoomLevel = 1.0;
        }
        
        // Update zoom level | 更新缩放级别
        this.zoomLevel = newZoomLevel;
        
        // Calculate new offsets to keep mouse point in same position | 计算新的偏移量，使鼠标指向的点保持在相同位置
        this.panOffsetX = mouseX - imageX * this.zoomLevel;
        this.panOffsetY = mouseY - imageY * this.zoomLevel;
        
        // Update zoom indicator | 更新缩放指示器
        showZoomIndicator(this.zoomIndicator, this.zoomLevel);
        
        // Re-render image | 重新渲染图像
        this.renderWithTransform();
    }
    
    // Handle mouse down event | 处理鼠标按下事件
    handleMouseDown(event) {
        if (!this.currentImageData || event.button !== 0) return;
        
        this.isDragging = true;
        this.dragStartX = event.clientX;
        this.dragStartY = event.clientY;
        this.lastPanOffsetX = this.panOffsetX;
        this.lastPanOffsetY = this.panOffsetY;
        
        // Change mouse cursor | 改变鼠标样式
        this.imageContainer.style.cursor = 'grabbing';
    }
    
    // Handle mouse move event | 处理鼠标移动事件
    handleMouseMove(event) {
        if (!this.currentImageData) return;
        
        // Get Canvas position and dimensions | 获取Canvas的位置和尺寸
        const rect = this.canvas.getBoundingClientRect();
        
        // Handle dragging | 处理拖动
        if (this.isDragging) {
            const deltaX = event.clientX - this.dragStartX;
            const deltaY = event.clientY - this.dragStartY;
            
            // Update pan offsets directly without boundary checking | 直接更新平移偏移量，不进行边界检查
            this.panOffsetX = this.lastPanOffsetX + deltaX;
            this.panOffsetY = this.lastPanOffsetY + deltaY;
            
            // Re-render image | 重新渲染图像
            this.renderWithTransform();
            return;
        }
        
        // Check if mouse is over Canvas | 检查鼠标是否在Canvas上
        if (event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom) {
            
            // Calculate coordinates on Canvas | 计算Canvas上的坐标
            const canvasX = event.clientX - rect.left;
            const canvasY = event.clientY - rect.top;
            
            // Calculate coordinates on image (considering zoom and pan) | 计算图像上的坐标（考虑缩放和平移）
            const imageX = Math.floor((canvasX - this.panOffsetX) / this.zoomLevel);
            const imageY = Math.floor((canvasY - this.panOffsetY) / this.zoomLevel);
            
            // Ensure coordinates are within image bounds | 确保坐标在图像范围内
            if (imageX >= 0 && imageX < this.currentImageData.width && 
                imageY >= 0 && imageY < this.currentImageData.height) {
                // Update coordinate display | 更新坐标显示
                document.getElementById('image-coords-x').textContent = imageX;
                document.getElementById('image-coords-y').textContent = imageY;
                
                // Get pixel value | 获取像素值
                const pixelIndex = imageY * this.currentImageData.width + imageX;
                
                // Display raw pixel value directly | 直接显示原始像素值
                if (pixelIndex >= 0 && pixelIndex < this.currentImageData.data.length) {
                    const rawValue = this.currentImageData.data[pixelIndex];
                    document.getElementById('pixel-value').textContent = rawValue.toString();
                }
                
                // Send coordinates to extension to get WCS coordinates | 发送坐标到扩展获取WCS坐标
                vscode.postMessage({
                    command: 'getPixelValue',
                    x: imageX,
                    y: imageY
                });
            }
        }
    }
    
    // Handle mouse up event | 处理鼠标抬起事件
    handleMouseUp() {
        if (this.isDragging) {
            this.isDragging = false;
            this.imageContainer.style.cursor = 'default';
        }
    }
    
    // Handle mouse leave event | 处理鼠标离开事件
    handleMouseLeave() {
        document.getElementById('pixel-info').style.display = 'none';
    }
    
    // Update slice and fit to container | 更新切片并适应容器
    updateSliceAndFit() {
        if (!this.originalImageData || !this.originalImageData.data3D) {
            console.warn('[ImageViewer] No original 3D data available for slice extraction');
            return;
        }
        
        // 提取当前切片
        const sliceResult = this.extract2DSlice(
            this.originalImageData.data3D,
            this.currentChannel,
            this.currentAxesOrder
        );
        
        if (!sliceResult) {
            console.error('[ImageViewer] Failed to extract 2D slice');
            return;
        }
        
        // 计算切片的最小值和最大值
        let min = Infinity;
        let max = -Infinity;
        
        for (let i = 0; i < sliceResult.data.length; i++) {
            const value = sliceResult.data[i];
            if (!isNaN(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }
        
        // 如果min和max相等，稍微调整max以避免除以零
        if (min === max) {
            max = min + 1;
        }
        
        // 保存原始切片数据，用于后续变换
        this.rawSliceData = {
            data: sliceResult.data,
            width: sliceResult.width,
            height: sliceResult.height,
            min: min,
            max: max
        };
        
        // 更新当前图像数据
        this.currentImageData = {
            data: new Float32Array(sliceResult.data),
            width: sliceResult.width,
            height: sliceResult.height,
            min: min,
            max: max
        };
        
        console.log(`[ImageViewer] Updated slice:
            Channel: ${this.currentChannel}
            Axes Order: [${this.currentAxesOrder.join(', ')}]
            Dimensions: ${this.rawSliceData.width}x${this.rawSliceData.height}
            Data Range: ${this.rawSliceData.min} to ${this.rawSliceData.max}
        `);
        
        // 更新通道值显示
        if (this.channelValue) {
            this.channelValue.textContent = `${this.currentChannel}/${this.maxChannel}`;
        }
        
        // 获取容器尺寸
        const container = this.imageContainer;
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        // 计算新的缩放级别以适应容器
        const scaleX = containerWidth / sliceResult.width;
        const scaleY = containerHeight / sliceResult.height;
        this.zoomLevel = Math.min(scaleX, scaleY) * 0.95;
        
        // 居中图像
        this.panOffsetX = (containerWidth - sliceResult.width * this.zoomLevel) / 2;
        this.panOffsetY = (containerHeight - sliceResult.height * this.zoomLevel) / 2;

        // 更新缩放指示器
        showZoomIndicator(this.zoomIndicator, this.zoomLevel);
        
        // 更新图像坐标显示
        document.getElementById('image-coords-x').textContent = '-';
        document.getElementById('image-coords-y').textContent = '-';
    }

    // Handle channel slider input | 处理通道滑块输入
    handleChannelSliderInput() {
        if (!this.channelSlider) return;
        
        // Get new channel value | 获取新的通道值
        const newChannel = parseInt(this.channelSlider.value);
        
        // Update channel if changed | 如果通道变化，则更新
        if (newChannel !== this.currentChannel) {
            this.currentChannel = newChannel;
            
            // Update slice and fit | 更新切片并适应
            this.updateSliceAndFit();
            
            // Apply current transform to slice | 应用当前变换到切片
            this.applyCurrentTransformToSlice();
        }
    }
    
    // Handle axes order change | 处理轴顺序变化
    handleAxesOrderChange() {
        if (!this.axesOrderSelector) return;
        
        // Get new axes order | 获取新的轴顺序
        const newAxesOrder = this.axesOrderSelector.value.split(',').map(Number);
        
        // Update axes order if changed | 如果轴顺序变化，则更新
        if (newAxesOrder.join(',') !== this.currentAxesOrder.join(',')) {
            this.currentAxesOrder = newAxesOrder;
            
            // Update slice and fit | 更新切片并适应
            this.updateSliceAndFit();
            
            // Apply current transform to slice | 应用当前变换到切片
            this.applyCurrentTransformToSlice();
        }
    }
    
    // 应用当前变换到已提取的切片
    applyCurrentTransformToSlice() {
        if (!this.rawSliceData) {
            console.warn('[ImageViewer] No raw slice data available for transform');
            return;
        }
        
        // 获取当前变换类型和范围类型
        const transformButton = document.querySelector('.transform-group .scale-button.active');
        const rangeButton = document.querySelector('.range-group .scale-button.active');
        
        // 获取变换类型和zscale标志
        const scaleType = transformButton ? transformButton.getAttribute('data-scale') : 'linear';
        const useZScale = rangeButton ? rangeButton.getAttribute('data-scale') === 'zscale' : false;
        
        console.log(`[ImageViewer] Applying current transform to slice:
            Scale Type: ${scaleType}
            Use ZScale: ${useZScale}
            Bias: ${this.biasValue}
            Contrast: ${this.contrastValue}
            Current Axes Order: [${this.currentAxesOrder.join(', ')}]
            Raw Slice Dimensions: ${this.rawSliceData.width}x${this.rawSliceData.height}
            Raw Slice Data Length: ${this.rawSliceData.data.length}
        `);
        
        // 直接在前端应用变换，而不是发送到后端
        this.applyTransformLocally(this.rawSliceData, scaleType, useZScale, this.biasValue, this.contrastValue);
    }
    
    // 新增方法：在前端本地应用变换
    applyTransformLocally(imageData, scaleType, useZScale, biasValue, contrastValue) {
        if (!imageData || !imageData.data) return;
        
        try {
            console.log(`[ImageViewer] Applying transform locally:
                Scale Type: ${scaleType}
                Use ZScale: ${useZScale}
                Bias: ${biasValue}
                Contrast: ${contrastValue}
                Image dimensions: ${imageData.width}x${imageData.height}
                Data length: ${imageData.data.length}
            `);
            
            // 创建变换后的数据数组
            const transformedData = new Float32Array(imageData.data.length);
            
            // 计算数据范围
            let min = imageData.min;
            let max = imageData.max;
            
            // 如果使用zscale，计算zscale范围
            if (useZScale) {
                // 计算zscale范围
                const zscaleResult = this.calculateZScale(imageData.data);
                if (zscaleResult) {
                    min = zscaleResult.z1;
                    max = zscaleResult.z2;
                    console.log(`[ImageViewer] Using ZScale range: ${min} to ${max}`);
                }
            }
            
            // 应用偏差和对比度
            const range = max - min;
            const center = min + range * biasValue;
            const width = range * contrastValue;
            const low = center - width / 2;
            const high = center + width / 2;
            
            // 归一化和应用变换
            for (let i = 0; i < imageData.data.length; i++) {
                // 归一化到[0,1]范围
                let value = (imageData.data[i] - low) / (high - low);
                value = Math.max(0, Math.min(1, value)); // 裁剪到[0,1]
                
                // 应用非线性变换
                if (scaleType === 'log') {
                    value = value <= 0 ? 0 : Math.log10(value * 9 + 1);
                } else if (scaleType === 'sqrt') {
                    value = Math.sqrt(value);
                } else if (scaleType === 'squared') {
                    value = value * value;
                } else if (scaleType === 'asinh') {
                    value = Math.asinh(value * 10) / 3;
                } else if (scaleType === 'sinh') {
                    value = Math.sinh(value * 3) / 10;
                } else if (scaleType === 'power') {
                    value = Math.pow(value, 2.5);
                } else if (scaleType === 'histogram') {
                    // 直方图均衡化在前端实现较复杂，这里简化处理
                    value = Math.pow(value, 0.5);
                }
                
                transformedData[i] = value;
            }
            
            // 更新图像数据，保持原始维度
            this.currentImageData = {
                data: transformedData,
                width: imageData.width,
                height: imageData.height,
                depth: imageData.depth,
                min: 0,
                max: 1
            };
            
            console.log(`[ImageViewer] Transform applied locally:
                Result dimensions: ${this.currentImageData.width}x${this.currentImageData.height}
                Result data length: ${this.currentImageData.data.length}
            `);
            
            // 重新渲染图像
            this.renderWithTransform();
            
        } catch (error) {
            console.error(`[ImageViewer] Error applying transform locally: ${error.message}`, error);
        }
    }
    
    // 添加计算ZScale的方法
    calculateZScale(data, contrast = 0.25, iterations = 5) {
        try {
            if (!data || data.length === 0) return null;
            
            // 常量
            const ZSMAX_REJECT = 0.5;
            const ZSMIN_NPIXELS = 5;
            const ZSMAX_ITERATIONS = iterations || 5;
            
            // 采样
            const width = this.rawSliceData.width;
            const height = this.rawSliceData.height;
            const numPerLine = 120;
            const numSamples = 600;
            
            const strideY = Math.max(2, Math.floor(height / numPerLine));
            const strideX = Math.max(2, Math.floor(width / numPerLine));
            
            // 创建采样数组
            const samples = [];
            for (let y = 0; y < height; y += strideY) {
                for (let x = 0; x < width; x += strideX) {
                    const value = data[y * width + x];
                    if (isFinite(value)) {
                        samples.push(value);
                    }
                }
            }
            
            if (samples.length === 0) {
                return { z1: data[0], z2: data[0] };
            }
            
            // 排序采样
            samples.sort((a, b) => a - b);
            
            // 计算中值
            const npix = samples.length;
            const centerPixel = Math.max(1, Math.floor((npix + 1) / 2));
            const median = npix % 2 === 1 || centerPixel >= npix ?
                samples[centerPixel - 1] :
                (samples[centerPixel - 1] + samples[centerPixel]) / 2.0;
            
            // 拟合直线
            const minPixels = Math.max(ZSMIN_NPIXELS, Math.floor(npix * ZSMAX_REJECT));
            const xscale = npix - 1;
            let ngoodpix = npix;
            let slope = 0;
            let intercept = median;
            
            // 迭代拟合
            for (let niter = 0; niter < ZSMAX_ITERATIONS; niter++) {
                if (ngoodpix < minPixels) {
                    return { z1: samples[0], z2: samples[samples.length - 1] };
                }
                
                // 最小二乘拟合
                let sumx = 0, sumy = 0, sumxy = 0, sumxx = 0;
                for (let i = 0; i < ngoodpix; i++) {
                    const x = i / xscale;
                    const y = samples[i];
                    sumx += x;
                    sumy += y;
                    sumxy += x * y;
                    sumxx += x * x;
                }
                
                const denominator = ngoodpix * sumxx - sumx * sumx;
                if (denominator !== 0) {
                    slope = (ngoodpix * sumxy - sumx * sumy) / denominator;
                    intercept = (sumy * sumxx - sumx * sumxy) / denominator;
                }
                
                // 计算残差
                let sigma = 0;
                const residuals = [];
                for (let i = 0; i < ngoodpix; i++) {
                    const x = i / xscale;
                    const fitted = x * slope + intercept;
                    const residual = samples[i] - fitted;
                    residuals.push(residual);
                    sigma += residual * residual;
                }
                sigma = Math.sqrt(sigma / ngoodpix);
                
                // 剔除离群点
                const newSamples = [];
                for (let i = 0; i < ngoodpix; i++) {
                    if (Math.abs(residuals[i]) < sigma * 2.5) {
                        newSamples.push(samples[i]);
                    }
                }
                
                if (newSamples.length === ngoodpix) {
                    break;
                }
                
                samples.length = 0;
                samples.push(...newSamples);
                ngoodpix = newSamples.length;
            }
            
            // 计算显示范围
            if (contrast > 0) {
                slope = slope / contrast;
            }
            
            const z1 = Math.max(samples[0], median - (centerPixel - 1) * slope);
            const z2 = Math.min(samples[samples.length - 1], median + (npix - centerPixel) * slope);
            
            console.log(`[ImageViewer] ZScale calculation result: z1=${z1}, z2=${z2}`);
            return { z1, z2 };
            
        } catch (error) {
            console.error(`[ImageViewer] Error calculating ZScale: ${error.message}`, error);
            return null;
        }
    }
    
    // Reset channel slider | 重置通道滑块
    resetChannelSlider() {
        if (!this.originalImageData) return;
        
        // Determine channel dimension size based on current axes order | 根据当前轴顺序确定通道维度的大小
        const channelDimIndex = this.currentAxesOrder[0];
        
        // Get channel dimension size | 获取通道维度的大小
        let channelDimSize = 1;
        if (channelDimIndex === 0 && this.originalImageData.depth) {
            channelDimSize = this.originalImageData.depth;
        } else if (channelDimIndex === 1 && this.originalImageData.height) {
            channelDimSize = this.originalImageData.height;
        } else if (channelDimIndex === 2 && this.originalImageData.width) {
            channelDimSize = this.originalImageData.width;
        }
        
        // Update slider range | 更新滑块范围
        this.maxChannel = Math.max(0, channelDimSize - 1);
        this.channelSlider.max = this.maxChannel;
        
        // Reset current channel | 重置当前通道
        this.currentChannel = 0;
        this.channelSlider.value = this.currentChannel;
        this.channelValue.textContent = `${this.currentChannel}/${this.maxChannel}`;
    }
    
    // Extract 2D slice from 3D data | 从3D数据中提取2D切片
    extract2DSlice(data3D, channel, axesOrder) {
        try {
            if (!data3D || !this.originalImageData) {
                console.error('[ImageViewer] No 3D data available for slice extraction');
                return null;
            }
            
            const width = this.originalImageData.width;
            const height = this.originalImageData.height;
            const depth = this.originalImageData.depth;
            
            if (!width || !height || !depth) {
                console.error('[ImageViewer] Invalid dimensions for 3D data');
                return null;
            }
            
            console.log(`[ImageViewer] Extracting 2D slice:
                Channel: ${channel}
                Axes Order: [${axesOrder.join(', ')}]
                Original Dimensions: ${width}x${height}x${depth}
                Data Length: ${data3D.length}
            `);
            
            // 确保通道索引在有效范围内
            const validChannel = Math.max(0, Math.min(depth - 1, channel));
            
            // 根据轴顺序确定切片维度
            let sliceWidth, sliceHeight;
            let widthAxis, heightAxis, depthAxis;
            
            // 解析轴顺序
            if (axesOrder && axesOrder.length === 3) {
                depthAxis = axesOrder[0];  // 通道/深度轴
                heightAxis = axesOrder[1]; // 高度轴
                widthAxis = axesOrder[2];  // 宽度轴
            } else {
                // 默认CHW顺序
                depthAxis = 0;
                heightAxis = 1;
                widthAxis = 2;
            }
            
            // 根据轴顺序确定切片维度
            if (depthAxis === 0) {
                if (heightAxis === 1 && widthAxis === 2) {
                    // CHW顺序
                    sliceWidth = width;
                    sliceHeight = height;
                } else {
                    // CWH顺序
                    sliceWidth = height;
                    sliceHeight = width;
                }
            } else if (depthAxis === 1) {
                if (heightAxis === 0 && widthAxis === 2) {
                    // HCW顺序
                    sliceWidth = width;
                    sliceHeight = depth;
                } else {
                    // HWC顺序
                    sliceWidth = depth;
                    sliceHeight = width;
                }
            } else {
                if (heightAxis === 0 && widthAxis === 1) {
                    // WCH顺序
                    sliceWidth = depth;
                    sliceHeight = height;
                } else {
                    // WHC顺序
                    sliceWidth = height;
                    sliceHeight = depth;
                }
            }
            
            // 创建2D切片数据
            const slice2D = new Float32Array(sliceWidth * sliceHeight);
            
            // 填充切片数据
            for (let y = 0; y < sliceHeight; y++) {
                for (let x = 0; x < sliceWidth; x++) {
                    // 根据轴顺序计算3D索引
                    let i, j, k;
                    
                    if (depthAxis === 0) {
                        i = validChannel;
                        if (heightAxis === 1 && widthAxis === 2) {
                            // CHW
                            j = y;
                            k = x;
                        } else {
                            // CWH
                            j = x;
                            k = y;
                        }
                    } else if (depthAxis === 1) {
                        j = validChannel;
                        if (heightAxis === 0 && widthAxis === 2) {
                            // HCW
                            i = y;
                            k = x;
                        } else {
                            // HWC
                            i = y;
                            k = x;
                        }
                    } else {
                        k = validChannel;
                        if (heightAxis === 0 && widthAxis === 1) {
                            // WCH
                            i = y;
                            j = x;
                        } else {
                            // WHC
                            i = x;
                            j = y;
                        }
                    }
                    
                    // 计算3D数据中的索引
                    const index3D = i * (height * width) + j * width + k;
                    
                    // 计算2D切片中的索引
                    const index2D = y * sliceWidth + x;
                    
                    // 复制数据
                    if (index3D >= 0 && index3D < data3D.length) {
                        slice2D[index2D] = data3D[index3D];
                    }
                }
            }
            
            console.log(`[ImageViewer] 2D slice extracted:
                Slice Dimensions: ${sliceWidth}x${sliceHeight}
                Slice Data Length: ${slice2D.length}
            `);
            
            return {
                data: slice2D,
                width: sliceWidth,
                height: sliceHeight
            };
            
        } catch (error) {
            console.error(`[ImageViewer] Error extracting 2D slice: ${error.message}`, error);
            return null;
        }
    }
    
    // Render image with transform | 使用变换渲染图像
    renderWithTransform() {
        if (!this.currentImageData) return;
        
        // Clear Canvas | 清除Canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Set Canvas size to container size | 设置Canvas尺寸为容器尺寸
        const container = this.imageContainer;
        this.canvas.width = container.clientWidth;
        this.canvas.height = container.clientHeight;
        
        // Draw image (apply zoom and pan) | 绘制图像（应用缩放和平移）
        this.ctx.save();
        
        // Ensure transform matrix won't cause numeric overflow | 确保变换矩阵不会导致数值溢出
        if (isFinite(this.panOffsetX) && isFinite(this.panOffsetY) && 
            isFinite(this.zoomLevel) && this.zoomLevel > 0) {
            
            // Apply transform | 应用变换
            this.ctx.translate(this.panOffsetX, this.panOffsetY);
            this.ctx.scale(this.zoomLevel, this.zoomLevel);
            
            // Check image size, use chunked processing if over threshold | 检查图像大小，如果超过阈值，则使用分块处理
            const isLargeImage = this.currentImageData.width * this.currentImageData.height > 4000000;
            
            if (isLargeImage) {
                this.renderLargeImageWithChunks();
            } else {
                this.renderStandardImage();
            }
            
        } else {
            // Reset transform if invalid values | 如果出现无效值，重置变换
            this.zoomLevel = 1.0;
            this.panOffsetX = (this.canvas.width - this.currentImageData.width) / 2;
            this.panOffsetY = (this.canvas.height - this.currentImageData.height) / 2;
            this.ctx.translate(this.panOffsetX, this.panOffsetY);
            this.ctx.scale(this.zoomLevel, this.zoomLevel);
            
            // Render image | 渲染图像
            if (this.currentImageData.width * this.currentImageData.height > 4000000) {
                this.renderLargeImageWithChunks();
            } else {
                this.renderStandardImage();
            }
        }
        
        this.ctx.restore();
        
        // Update status info | 更新状态信息
        updateStatusInfo(this.currentImageData, this.zoomLevel);
    }
    
    // Standard image rendering method | 标准图像渲染方法
    renderStandardImage() {
        // Create ImageData object | 创建ImageData对象
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.currentImageData.width;
        tempCanvas.height = this.currentImageData.height;
        const tempCtx = tempCanvas.getContext('2d');
        const imageData = tempCtx.createImageData(this.currentImageData.width, this.currentImageData.height);
        
        try {
            // Use TypedArray and vectorized operations to process image data | 使用 TypedArray 和向量化操作处理图像数据
            const pixelCount = this.currentImageData.width * this.currentImageData.height;
            const rgbaData = new Uint8ClampedArray(pixelCount * 4);
            
            // Vectorized processing - calculate all pixel values at once | 向量化处理 - 一次性计算所有像素值
            for (let i = 0; i < pixelCount; i++) {
                // Apply bias and contrast to normalized value | 对归一化值应用偏差和对比度
                const normalizedValue = this.applyBiasAndContrast(
                    this.currentImageData.data[i],
                    this.currentImageData.min,
                    this.currentImageData.max
                );
                
                // Convert to 8-bit value | 转换为8位值
                const scaledValue = Math.round(normalizedValue * 255);
                
                // Set RGBA values (grayscale image, R=G=B) | 设置 RGBA 值 (灰度图像，R=G=B)
                const idx = i * 4;
                rgbaData[idx] = scaledValue;     // R
                rgbaData[idx + 1] = scaledValue; // G
                rgbaData[idx + 2] = scaledValue; // B
                rgbaData[idx + 3] = 255;         // A
            }
            
            // Set imageData data directly | 直接设置 imageData 的数据
            imageData.data.set(rgbaData);
            
            // Draw ImageData to temporary Canvas | 将ImageData绘制到临时Canvas
            tempCtx.putImageData(imageData, 0, 0);
            
            // Draw temporary Canvas to main Canvas | 将临时Canvas绘制到主Canvas
            this.ctx.drawImage(tempCanvas, 0, 0);
            
        } catch (error) {
            log(`Error rendering image: ${error.message} | 渲染图像时出错: ${error.message}`);
            document.getElementById('image-placeholder').textContent = `Error rendering image: ${error.message} | 渲染图像时出错: ${error.message}`;
        }
    }
    
    // Render large image with chunks | 分块渲染大图像
    renderLargeImageWithChunks() {
        try {
            // Calculate scale factor | 计算缩放因子
            const scale = 255 / (this.currentImageData.max - this.currentImageData.min);
            
            // Create temporary Canvas | 创建临时Canvas
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.currentImageData.width;
            tempCanvas.height = this.currentImageData.height;
            const tempCtx = tempCanvas.getContext('2d');
            
            // Process image in chunks | 分块处理整个图像
            const chunkSize = 1000; // Pixel rows per chunk | 每块的像素行数
            
            // Create ImageData for full image | 创建整个图像的ImageData
            const fullImageData = tempCtx.createImageData(this.currentImageData.width, this.currentImageData.height);
            const fullData = new Uint8ClampedArray(this.currentImageData.width * this.currentImageData.height * 4);
            
            // Process chunks | 分块处理
            for (let startY = 0; startY < this.currentImageData.height; startY += chunkSize) {
                const endY = Math.min(startY + chunkSize, this.currentImageData.height);
                const chunkHeight = endY - startY;
                
                // Process pixels in current chunk | 处理当前块的像素
                for (let y = startY; y < endY; y++) {
                    const rowOffset = y * this.currentImageData.width;
                    
                    for (let x = 0; x < this.currentImageData.width; x++) {
                        const srcIdx = rowOffset + x;
                        const destIdx = srcIdx * 4;
                        
                        // Calculate scaled grayscale value | 计算缩放后的灰度值
                        const scaledValue = Math.max(0, Math.min(255, Math.round((this.currentImageData.data[srcIdx] - this.currentImageData.min) * scale)));
                        
                        // Set RGBA values | 设置 RGBA 值
                        fullData[destIdx] = scaledValue;     // R
                        fullData[destIdx + 1] = scaledValue; // G
                        fullData[destIdx + 2] = scaledValue; // B
                        fullData[destIdx + 3] = 255;         // A
                    }
                }
            }
            
            // Set ImageData | 设置ImageData
            fullImageData.data.set(fullData);
            
            // Draw ImageData to temporary Canvas | 将ImageData绘制到临时Canvas
            tempCtx.putImageData(fullImageData, 0, 0);
            
            // Draw temporary Canvas to main Canvas at original size | 将临时Canvas绘制到主Canvas，使用原始尺寸
            this.ctx.drawImage(tempCanvas, 0, 0);
            
        } catch (error) {
            log(`Error rendering image in chunks: ${error.message} | 分块渲染图像时出错: ${error.message}`);
            document.getElementById('image-placeholder').textContent = `Error rendering image: ${error.message} | 渲染图像时出错: ${error.message}`;
        }
    }
    
    // Load image data | 加载图像数据
    loadImageData(rawData, prevZoomLevel, prevPanOffsetX, prevPanOffsetY, prevWidth, prevHeight) {
        // Clear previous data
        if (this.currentImageData) {
            this.currentImageData = null;
        }
        if (this.originalImageData) {
            this.originalImageData = null;
        }
        if (this.rawSliceData) {
            this.rawSliceData = null;
        }

        if (!rawData || !rawData.data || !rawData.width || !rawData.height) {
            log('Invalid image data | 图像数据无效');
            return;
        }
        
        // Initialize scale type | 初始化缩放类型
        this.useZScale = false;
        this.currentScaleType = 'linear';
        this.biasValue = 0.5;
        this.contrastValue = 1.0;
        
        // Update UI buttons | 更新UI按钮
        if (this.minmaxButton) {
            this.minmaxButton.classList.add('active');
            this.zscaleButton.classList.remove('active');
        }
        
        this.scaleTypeButtons.forEach(button => {
            if (button.dataset.scaleType === 'linear') {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });
        
        // Check if multi-dimensional data | 检查是否是多维数据
        const isMultiDimensional = rawData.depth && rawData.depth > 1;
        
        // If multi-dimensional data, save original data and show channel selector | 如果是多维数据，保存原始数据并显示通道选择器
        if (isMultiDimensional) {
            this.isMultiDimensional = true;
            document.getElementById('channel-selector-container').style.display = 'block';
            
            // 更新通道相关UI
            this.maxChannel = Math.max(0, rawData.depth - 1);
            this.channelSlider.max = this.maxChannel;
            this.currentChannel = 0;
            this.channelSlider.value = this.currentChannel;
            this.channelValue.textContent = `${this.currentChannel}/${this.maxChannel}`;
            
            // 更新轴顺序选择器
            if (this.axesOrderSelector) {
                // 默认使用CHW顺序
                this.currentAxesOrder = [0, 1, 2];
                this.axesOrderSelector.value = this.currentAxesOrder.join(',');
            }
            
            // Save original multi-dimensional data | 保存原始多维数据
            this.originalImageData = {
                data3D: rawData.data instanceof Float32Array ? rawData.data : new Float32Array(rawData.data),
                width: rawData.width,
                height: rawData.height,
                depth: rawData.depth,
                min: rawData.min,
                max: rawData.max
            };
            
            // Show channel selector | 显示通道选择器
            document.getElementById('channel-selector-container').style.display = 'block';
            
            // Extract initial slice | 提取初始切片
            this.updateSliceAndFit();
            
            // 应用当前变换到切片
            this.applyCurrentTransformToSlice();
        } else {
            // Hide channel selector | 隐藏通道选择器
            document.getElementById('channel-selector-container').style.display = 'none';
            
            // Clear original multi-dimensional data | 清除原始多维数据
            this.originalImageData = null;
            
            // Save current image data | 保存当前图像数据
            this.currentImageData = {
                data: rawData.data instanceof Float32Array ? rawData.data : new Float32Array(rawData.data),
                width: rawData.width,
                height: rawData.height,
                min: rawData.min,
                max: rawData.max
            };
            
            // 保存原始切片数据，用于后续变换
            this.rawSliceData = {
                data: new Float32Array(this.currentImageData.data),
                width: this.currentImageData.width,
                height: this.currentImageData.height,
                min: this.currentImageData.min,
                max: this.currentImageData.max
            };
            
            // 应用当前变换到切片
            this.applyCurrentTransformToSlice();
        }
        
        // Show Canvas, hide placeholder | 显示Canvas，隐藏占位符
        this.canvas.style.display = 'block';
        document.getElementById('image-placeholder').style.display = 'none';
        
        // Ensure canvas size matches container size | 确保canvas大小与容器大小一致
        const container = this.imageContainer;
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        // Update canvas size if it doesn't match container size | 如果canvas大小与容器大小不一致，则更新canvas大小
        if (this.canvas.width !== containerWidth || this.canvas.height !== containerHeight) {
            this.canvas.width = containerWidth;
            this.canvas.height = containerHeight;
        }
        
        // Reset view if first load or image dimensions changed | 如果是首次加载或图像尺寸变化，则重置视图
        if (!prevZoomLevel || !prevWidth || !prevHeight || 
            prevWidth !== this.currentImageData.width || prevHeight !== this.currentImageData.height) {
            // Reset zoom and pan | 重置缩放和平移
            this.zoomLevel = 1.0;
            this.panOffsetX = 0;
            this.panOffsetY = 0;
            
            // Calculate initial zoom level to fit container | 计算初始缩放级别，使图像适应容器
            const scaleX = containerWidth / this.currentImageData.width;
            const scaleY = containerHeight / this.currentImageData.height;
            this.zoomLevel = Math.min(scaleX, scaleY) * 0.95;
            
            // Ensure zoom level is not too small | 确保缩放级别不会太小
            this.zoomLevel = Math.max(this.zoomLevel, 0.1);
            
            // Center the image | 居中图像
            this.panOffsetX = (containerWidth - this.currentImageData.width * this.zoomLevel) / 2;
            this.panOffsetY = (containerHeight - this.currentImageData.height * this.zoomLevel) / 2;
        } else {
            // Keep previous zoom and pan state | 保持之前的缩放和平移状态
            this.zoomLevel = prevZoomLevel;
            this.panOffsetX = prevPanOffsetX;
            this.panOffsetY = prevPanOffsetY;
        }
        
        // Update zoom indicator | 更新缩放指示器
        showZoomIndicator(this.zoomIndicator, this.zoomLevel);
        
        // Render the image | 渲染图像
        this.renderWithTransform();
    }
    
    // Load image data from binary file | 从二进制文件加载图像数据
    async loadImageDataFromFile(fileUri, prevZoomLevel, prevPanOffsetX, prevPanOffsetY, prevWidth, prevHeight) {
        // Clear previous data
        if (this.currentImageData) {
            this.currentImageData = null;
        }
        if (this.originalImageData) {
            this.originalImageData = null;
        }

        try {
            document.getElementById('image-placeholder').textContent = 'Loading image data...';
            
            // Get binary data | 获取二进制数据
            const response = await fetch(fileUri);
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            
            // Read header length | 读取头部长度
            const headerLengthView = new DataView(arrayBuffer, 0, 4);
            const headerLength = headerLengthView.getUint32(0, true); // Little endian | 小端字节序
            
            // Read metadata | 读取元数据
            const metadataBytes = new Uint8Array(arrayBuffer, 4, headerLength);
            const metadataJson = new TextDecoder().decode(metadataBytes);
            const metadata = JSON.parse(metadataJson);
            
            // Read image data | 读取图像数据
            const dataStart = 4 + headerLength;
            const dataBuffer = arrayBuffer.slice(dataStart);
            const imageData = new Float32Array(dataBuffer);
            
            // Create complete data object | 创建完整的数据对象
            const rawData = {
                data: imageData,
                width: metadata.width,
                height: metadata.height,
                min: metadata.min,
                max: metadata.max
            };
            
            // Add depth information if available | 如果有深度信息，添加到数据对象
            if (metadata.depth) {
                rawData.depth = metadata.depth;
            }
            
            // Load image data | 加载图像数据
            this.loadImageData(rawData, prevZoomLevel, prevPanOffsetX, prevPanOffsetY, prevWidth, prevHeight);
            
        } catch (error) {
            log(`Error loading image data file: ${error.message} | 加载图像数据文件时出错: ${error.message}`);
            document.getElementById('image-placeholder').textContent = `Error loading image data file: ${error.message} | 加载图像数据文件时出错: ${error.message}`;
            this.canvas.style.display = 'none';
            document.getElementById('image-placeholder').style.display = 'block';
        }
    }
    
    // Handle bias slider input | 处理偏差滑块输入
    handleBiasSliderInput() {
        this.biasValue = parseFloat(this.biasSlider.value);
        this.biasValue = Math.max(0, Math.min(1, this.biasValue));
        this.biasValueDisplay.textContent = this.biasValue.toFixed(2);
        
        // 使用本地变换而不是发送到后端
        this.applyCurrentTransformToSlice();
    }
    
    // Handle contrast slider input | 处理对比度滑块输入
    handleContrastSliderInput() {
        this.contrastValue = parseFloat(this.contrastSlider.value);
        this.contrastValue = Math.max(0.1, Math.min(10, this.contrastValue));
        this.contrastValueDisplay.textContent = this.contrastValue.toFixed(2);
        
        // 使用本地变换而不是发送到后端
        this.applyCurrentTransformToSlice();
    }
    
    // Apply bias and contrast to pixel value | 对像素值应用偏差和对比度
    applyBiasAndContrast(value, min, max) {
        // Normalize value to 0-1 range | 将值归一化到0-1范围
        const normalizedValue = (value - min) / (max - min);
        
        // Apply bias | 应用偏差
        let adjustedValue = normalizedValue - (this.biasValue - 0.5);
        
        // Apply contrast | 应用对比度
        if (this.contrastValue !== 1.0) {
            adjustedValue = Math.pow(adjustedValue, 1 / this.contrastValue);
        }
        
        // Clamp value to 0-1 range | 将值限制在0-1范围内
        return Math.max(0, Math.min(1, adjustedValue));
    }
    
    // Update display | 更新显示
    async updateDisplay() {
        if (!this.currentImageData) return;

        try {
            // Get current transform type and range type | 获取当前变换类型和范围类型
            const transformButton = document.querySelector('.transform-group .scale-button.active');
            const rangeButton = document.querySelector('.range-group .scale-button.active');
            
            // Get transform type and use zscale flag | 获取变换类型和zscale标志
            const scaleType = transformButton ? transformButton.getAttribute('data-scale') : 'linear';
            const useZScale = rangeButton ? rangeButton.getAttribute('data-scale') === 'zscale' : false;

            console.log(`[ImageViewer] Applying transform:
                Scale Type: ${scaleType}
                Use ZScale: ${useZScale}
                Bias: ${this.biasValue}
                Contrast: ${this.contrastValue}
                Channel: ${this.currentChannel}
                Axes Order: [${this.currentAxesOrder.join(', ')}]
            `);

            // 使用本地变换而不是发送到后端
            // 这样可以确保保持当前的轴顺序
            if (this.rawSliceData) {
                this.applyTransformLocally(this.rawSliceData, scaleType, useZScale, this.biasValue, this.contrastValue);
                return;
            }

            // 如果没有原始切片数据，则发送到后端（兼容旧代码）
            vscode.postMessage({
                command: 'applyScaleTransform',
                scaleType: scaleType,
                useZScale: useZScale,
                biasValue: this.biasValue,
                contrastValue: this.contrastValue,
                channel: this.currentChannel,
                axesOrder: this.currentAxesOrder
            });
        } catch (error) {
            console.error(`[ImageViewer] Error in updateDisplay: ${error.message}`, error);
        }
    }

    // Update image data | 更新图像数据
    updateImageData(data, min, max, width, height) {
        if (!data) {
            console.error('[ImageViewer] Received null data in updateImageData');
            return;
        }

        // 如果提供了宽度和高度，使用提供的值；否则使用当前值
        const imageWidth = width || (this.currentImageData ? this.currentImageData.width : null);
        const imageHeight = height || (this.currentImageData ? this.currentImageData.height : null);

        if (!imageWidth || !imageHeight) {
            console.error('[ImageViewer] Missing width or height in updateImageData');
            return;
        }

        console.log(`[ImageViewer] Updating image data:
            Data length: ${data.length}
            Width: ${imageWidth}
            Height: ${imageHeight}
            Depth: ${this.currentImageData ? this.currentImageData.depth || 'N/A' : 'N/A'}
            New min: ${min}
            New max: ${max}
            First 5 values: ${data.slice(0, 5)}
            Last 5 values: ${data.slice(-5)}
            Expected size: ${imageWidth * imageHeight}
        `);

        // 验证数据长度
        if (data.length !== imageWidth * imageHeight) {
            console.warn(`[ImageViewer] Data length mismatch:
                Expected: ${imageWidth * imageHeight}
                Actual: ${data.length}
                This might cause display issues.
            `);
        }

        // Update current image data | 更新当前图像数据
        this.currentImageData = {
            data: data,
            width: imageWidth,
            height: imageHeight,
            depth: this.currentImageData ? this.currentImageData.depth : 1,
            min: min,
            max: max
        };

        // Re-render image | 重新渲染图像
        this.renderWithTransform();
    }

    cleanup() {
        // Remove event listeners
        window.removeEventListener('beforeunload', this.cleanup);
        this.imageContainer.removeEventListener('wheel', this.handleWheel);
        this.imageContainer.removeEventListener('mousedown', this.handleMouseDown);
        this.imageContainer.removeEventListener('mousemove', this.handleMouseMove);
        this.imageContainer.removeEventListener('mouseleave', this.handleMouseLeave);
        window.removeEventListener('mouseup', this.handleMouseUp);

        if (this.channelSlider) {
            this.channelSlider.removeEventListener('input', this.handleChannelSliderInput);
        }

        if (this.axesOrderSelector) {
            this.axesOrderSelector.removeEventListener('change', this.handleAxesOrderChange);
        }

        if (this.biasSlider) {
            this.biasSlider.removeEventListener('input', this.handleBiasSliderInput);
        }

        if (this.contrastSlider) {
            this.contrastSlider.removeEventListener('input', this.handleContrastSliderInput);
        }

        // Stop resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        // Clear canvas
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }

        // Clear image data
        this.currentImageData = null;
        this.originalImageData = null;
    }
}

// Export ImageViewer class | 导出图像查看器类
export default ImageViewer;