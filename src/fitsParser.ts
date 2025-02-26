/**
 * FITS文件解析器
 * 用于解析FITS文件并提取头信息和数据
 */

// FITS文件头信息项
export interface FITSHeaderItem {
    key: string;
    value: any;
    comment?: string;
}

// FITS文件头信息
export class FITSHeader {
    private items: FITSHeaderItem[] = [];
    
    constructor() {}
    
    // 添加头信息项
    addItem(key: string, value: any, comment?: string): void {
        this.items.push({ key, value, comment });
    }
    
    // 获取头信息项
    getItem(key: string): FITSHeaderItem | undefined {
        return this.items.find(item => item.key === key);
    }
    
    // 获取所有头信息项
    getAllItems(): FITSHeaderItem[] {
        return this.items;
    }
}

// FITS文件HDU（Header Data Unit）
export class FITSHDU {
    constructor(
        public header: FITSHeader,
        public data: Float32Array | null = null
    ) {}
}

// FITS文件
export class FITS {
    constructor(
        public headers: FITSHeader[] = [],
        public hdus: FITSHDU[] = []
    ) {}
    
    // 获取指定索引的HDU
    getHDU(index: number): FITSHDU | undefined {
        if (index >= 0 && index < this.hdus.length) {
            return this.hdus[index];
        }
        return undefined;
    }
}

// FITS文件解析器
export class FITSParser {
    // 解析FITS文件
    parseFITS(buffer: Uint8Array): FITS {
        console.log('开始解析FITS文件...');
        const fits = new FITS();
        
        // 检查FITS文件头
        if (buffer.length < 2880 || !this.checkFITSSignature(buffer)) {
            throw new Error('无效的FITS文件');
        }
        
        let offset = 0;
        
        // 解析主头信息
        console.log('解析主头信息...');
        const primaryHeader = this.parseHeader(buffer, offset);
        fits.headers.push(primaryHeader);
        
        // 计算数据块大小
        const bitpix = primaryHeader.getItem('BITPIX')?.value || 0;
        const naxis = primaryHeader.getItem('NAXIS')?.value || 0;
        
        console.log(`BITPIX: ${bitpix}, NAXIS: ${naxis}`);
        
        let dataSize = 0;
        if (naxis > 0) {
            dataSize = Math.abs(bitpix) / 8;
            
            for (let i = 1; i <= naxis; i++) {
                const axisSize = primaryHeader.getItem(`NAXIS${i}`)?.value || 0;
                dataSize *= axisSize;
                console.log(`NAXIS${i}: ${axisSize}`);
            }
        }
        
        console.log(`数据大小: ${dataSize} 字节`);
        
        // 计算头信息块数
        const headerSize = this.findHeaderEnd(buffer, 0);
        const headerBlocks = Math.ceil(headerSize / 2880);
        offset = headerBlocks * 2880;
        
        console.log(`头信息大小: ${headerSize} 字节, ${headerBlocks} 个块`);
        
        // 解析数据
        let data: Float32Array | null = null;
        
        if (dataSize > 0) {
            console.log('解析主数据...');
            data = this.parseData(buffer, offset, primaryHeader);
            
            // 计算数据块数
            const dataBlocks = Math.ceil(dataSize / 2880);
            offset += dataBlocks * 2880;
            
            console.log(`数据块数: ${dataBlocks}`);
        }
        
        // 创建主HDU
        const primaryHDU = new FITSHDU(primaryHeader, data);
        fits.hdus.push(primaryHDU);
        
        // 解析扩展HDU
        let extCount = 0;
        const maxExtensions = 10; // 限制扩展数量，防止无限循环
        
        while (offset < buffer.length && extCount < maxExtensions) {
            // 检查是否还有足够的数据
            if (buffer.length - offset < 2880) {
                console.log('剩余数据不足一个块，停止解析');
                break;
            }
            
            try {
                console.log(`解析扩展 #${extCount + 1}...`);
                
                // 检查是否是有效的扩展头
                if (!this.isValidExtension(buffer, offset)) {
                    console.log('未找到有效的扩展头，停止解析');
                    break;
                }
                
                // 解析扩展头信息
                const extHeader = this.parseHeader(buffer, offset);
                
                // 检查是否找到END关键字
                if (extHeader.getAllItems().length === 0) {
                    console.log('扩展头为空，停止解析');
                    break;
                }
                
                fits.headers.push(extHeader);
                
                // 计算扩展数据块大小
                const extBitpix = extHeader.getItem('BITPIX')?.value || 0;
                const extNaxis = extHeader.getItem('NAXIS')?.value || 0;
                
                console.log(`扩展 BITPIX: ${extBitpix}, NAXIS: ${extNaxis}`);
                
                let extDataSize = 0;
                if (extNaxis > 0) {
                    extDataSize = Math.abs(extBitpix) / 8;
                    
                    for (let i = 1; i <= extNaxis; i++) {
                        const axisSize = extHeader.getItem(`NAXIS${i}`)?.value || 0;
                        extDataSize *= axisSize;
                        console.log(`扩展 NAXIS${i}: ${axisSize}`);
                    }
                }
                
                console.log(`扩展数据大小: ${extDataSize} 字节`);
                
                // 计算扩展头信息大小
                const extHeaderSize = this.findHeaderEnd(buffer, offset);
                const extHeaderBlocks = Math.ceil(extHeaderSize / 2880);
                const newOffset = offset + extHeaderBlocks * 2880;
                
                console.log(`扩展头大小: ${extHeaderSize} 字节, ${extHeaderBlocks} 个块`);
                
                // 解析扩展数据
                let extData: Float32Array | null = null;
                
                if (extDataSize > 0 && newOffset + extDataSize <= buffer.length) {
                    console.log('解析扩展数据...');
                    extData = this.parseData(buffer, newOffset, extHeader);
                    
                    // 计算扩展数据块数
                    const extDataBlocks = Math.ceil(extDataSize / 2880);
                    offset = newOffset + extDataBlocks * 2880;
                    
                    console.log(`扩展数据块数: ${extDataBlocks}`);
                } else {
                    offset = newOffset;
                }
                
                // 创建扩展HDU
                const extHDU = new FITSHDU(extHeader, extData);
                fits.hdus.push(extHDU);
                
                extCount++;
            } catch (error) {
                console.error(`解析扩展 #${extCount + 1} 时出错:`, error);
                break;
            }
        }
        
        console.log(`解析完成，共 ${fits.hdus.length} 个HDU`);
        return fits;
    }
    
    // 检查是否是有效的扩展头
    private isValidExtension(buffer: Uint8Array, offset: number): boolean {
        // 检查前80个字节是否包含XTENSION关键字
        const line = this.readLine(buffer, offset);
        return line.startsWith('XTENSION');
    }
    
    // 查找头信息结束位置
    private findHeaderEnd(buffer: Uint8Array, startOffset: number): number {
        let offset = startOffset;
        const maxLines = 1000; // 防止无限循环
        let lineCount = 0;
        
        while (offset < buffer.length && lineCount < maxLines) {
            // 读取一行（80字节）
            const line = this.readLine(buffer, offset);
            offset += 80;
            lineCount++;
            
            // 检查是否是头信息结束标记
            if (line.startsWith('END')) {
                return offset;
            }
        }
        
        // 如果没有找到END标记，返回起始偏移量
        return startOffset;
    }
    
    // 检查FITS文件头签名
    private checkFITSSignature(buffer: Uint8Array): boolean {
        // FITS文件头应该以"SIMPLE  ="开头
        const signature = "SIMPLE  =";
        
        for (let i = 0; i < signature.length; i++) {
            if (buffer[i] !== signature.charCodeAt(i)) {
                return false;
            }
        }
        
        return true;
    }
    
    // 解析头信息
    private parseHeader(buffer: Uint8Array, offset: number): FITSHeader {
        const header = new FITSHeader();
        let currentOffset = offset;
        const maxLines = 1000; // 防止无限循环
        let lineCount = 0;
        
        // 读取头信息
        while (currentOffset < buffer.length && lineCount < maxLines) {
            // 读取一行（80字节）
            const line = this.readLine(buffer, currentOffset);
            currentOffset += 80;
            lineCount++;
            
            // 检查是否是头信息结束标记
            if (line.startsWith('END')) {
                break;
            }
            
            // 解析头信息项
            const item = this.parseHeaderItem(line);
            if (item) {
                header.addItem(item.key, item.value, item.comment);
            }
        }
        
        return header;
    }
    
    // 读取一行（80字节）
    private readLine(buffer: Uint8Array, offset: number): string {
        if (offset + 80 > buffer.length) {
            return '';
        }
        
        const bytes = buffer.slice(offset, offset + 80);
        return new TextDecoder().decode(bytes);
    }
    
    // 解析头信息项
    private parseHeaderItem(line: string): FITSHeaderItem | null {
        // 头信息项格式：KEYWORD = VALUE / COMMENT
        const keyValueMatch = line.match(/^([A-Z0-9_-]+)\s*=\s*(.+?)(?:\s*\/\s*(.*))?$/);
        
        if (keyValueMatch) {
            const key = keyValueMatch[1].trim();
            let valueStr = keyValueMatch[2].trim();
            const comment = keyValueMatch[3]?.trim();
            
            // 解析值
            let value: any;
            
            if (valueStr.startsWith("'") && valueStr.includes("'")) {
                // 字符串值
                const endQuotePos = valueStr.lastIndexOf("'");
                value = valueStr.substring(1, endQuotePos).trim();
            } else if (valueStr === 'T') {
                // 布尔值（真）
                value = true;
            } else if (valueStr === 'F') {
                // 布尔值（假）
                value = false;
            } else {
                // 数值
                const numValue = parseFloat(valueStr);
                if (!isNaN(numValue)) {
                    value = numValue;
                } else {
                    value = valueStr;
                }
            }
            
            return { key, value, comment };
        }
        
        return null;
    }
    
    // 解析数据
    private parseData(buffer: Uint8Array, offset: number, header: FITSHeader): Float32Array {
        // 获取数据类型和维度信息
        const bitpix = header.getItem('BITPIX')?.value || 0;
        const naxis = header.getItem('NAXIS')?.value || 0;
        
        // 计算数据大小
        let dataSize = 1;
        for (let i = 1; i <= naxis; i++) {
            const axisSize = header.getItem(`NAXIS${i}`)?.value || 0;
            dataSize *= axisSize;
        }
        
        // 创建数据数组
        const data = new Float32Array(dataSize);
        
        // 根据BITPIX解析数据
        const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
        
        // 获取BZERO和BSCALE（如果有）
        const bzero = header.getItem('BZERO')?.value || 0;
        const bscale = header.getItem('BSCALE')?.value || 1;
        
        try {
            for (let i = 0; i < dataSize; i++) {
                let value = 0;
                
                switch (bitpix) {
                    case 8: // 无符号字节
                        value = view.getUint8(i);
                        break;
                    case 16: // 16位整数
                        value = view.getInt16(i * 2, false); // FITS使用大端字节序
                        break;
                    case 32: // 32位整数
                        value = view.getInt32(i * 4, false);
                        break;
                    case 64: // 64位整数
                        // JavaScript不能精确表示64位整数，这里使用近似值
                        const high = view.getInt32(i * 8, false);
                        const low = view.getInt32(i * 8 + 4, false);
                        value = high * Math.pow(2, 32) + low;
                        break;
                    case -32: // 32位浮点数
                        value = view.getFloat32(i * 4, false);
                        break;
                    case -64: // 64位浮点数
                        value = view.getFloat64(i * 8, false);
                        break;
                    default:
                        throw new Error(`不支持的BITPIX值: ${bitpix}`);
                }
                
                // 应用BZERO和BSCALE
                data[i] = value * bscale + bzero;
            }
        } catch (error) {
            console.error('解析数据时出错:', error);
            // 返回空数组
            return new Float32Array(0);
        }
        
        return data;
    }
} 