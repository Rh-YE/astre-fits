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

// 基本常量定义
const FLEN_CARD = 80;      // 卡片长度
const MAX_PREFIX_LEN = 20; // 文件类型前缀最大长度
const NOT_FITS = 108;      // 错误代码：非FITS文件
const FITS_BLOCK_SIZE = 2880; // FITS块大小

// HDU类型枚举
export enum HDUType {
    IMAGE_HDU = 0,
    ASCII_TBL = 1,
    BINARY_TBL = 2
}

// FITS文件结构
interface FITSfile {
    filehandle: number;
    driver: number;
    filename: string;
    filesize: number;
    writemode: number;
    datastart: number;
    iobuffer: Uint8Array;
    headstart: number[];
}

interface Fitsfile {
    Fptr: FITSfile;
}

// FITS文件解析器
export class FITSParser {
    private fptr: Fitsfile | null = null;

    // 解析FITS文件
    parseFITS(buffer: Uint8Array): FITS {
        console.log('开始解析FITS文件...');
        const fits = new FITS();
        
        // 检查FITS文件头
        if (buffer.length < FITS_BLOCK_SIZE) {
            throw new Error('无效的FITS文件格式');
        }
        
        // 初始化Fitsfile结构
        let status = 0;
        status = this.ffopen(buffer);
        if (status > 0) {
            throw new Error('无效的FITS文件格式');
        }
        
        // 验证HDU类型
        let hdutype = HDUType.IMAGE_HDU;
        status = this.ffrhdu(hdutype, status);
        if (status > 0) {
            throw new Error('无效的HDU格式');
        }
        
        let offset = 0;
        let currentHDUType: HDUType;
        
        // 解析主头信息
        console.log('解析主头信息...');
        const primaryHeader = this.parseHeader(buffer, offset);
        
        // 验证主HDU
        if (!this.validatePrimaryHDU(primaryHeader)) {
            throw new Error('无效的主HDU格式');
        }
        
        fits.headers.push(primaryHeader);
        currentHDUType = HDUType.IMAGE_HDU;
        
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
        
        // 计算头信息块数和数据块数
        const headerSize = this.findHeaderEnd(buffer, 0);
        const headerBlocks = Math.ceil(headerSize / 2880);
        const headerEnd = headerBlocks * 2880;
        
        console.log(`头信息大小: ${headerSize} 字节, ${headerBlocks} 个块, 结束于 ${headerEnd}`);
        
        // 计算数据块数并调整偏移量
        const dataBlocks = Math.ceil(dataSize / 2880);
        const dataEnd = headerEnd + dataBlocks * 2880;
        
        console.log(`数据块数: ${dataBlocks}, 数据结束于 ${dataEnd}`);
        
        // 解析主HDU数据（如果有）
        let data: Float32Array | null = null;
        if (dataSize > 0) {
            console.log('解析主数据...');
            data = this.parseData(buffer, headerEnd, primaryHeader);
        }
        
        // 创建主HDU
        const primaryHDU = new FITSHDU(primaryHeader, data);
        fits.hdus.push(primaryHDU);
        
        // 更新偏移量到下一个HDU
        offset = dataEnd;
        
        // 解析扩展HDU
        let extCount = 0;
        const maxExtensions = 10; // 限制扩展数量，防止无限循环
        
        while (offset < buffer.length && extCount < maxExtensions) {
            try {
                console.log(`解析扩展 #${extCount + 1}...`);
                console.log(`当前偏移量: ${offset}`);
                
                // 检查是否还有足够的数据
                if (buffer.length - offset < 2880) {
                    console.log('剩余数据不足一个块，停止解析');
                    break;
                }
                
                // 检查是否是有效的扩展头
                if (!this.isValidExtension(buffer, offset)) {
                    console.log('未找到有效的扩展头，停止解析');
                    break;
                }
                
                // 解析扩展头信息
                const extHeader = this.parseHeader(buffer, offset);
                console.log(`扩展 HDU #${extCount + 1} 头信息关键字: `, extHeader.getAllItems().map(item => item.key));
                
                // 检查是否找到END关键字
                if (extHeader.getAllItems().length === 0) {
                    console.log('扩展头为空，停止解析');
                    break;
                }
                
                fits.headers.push(extHeader);
                
                // 计算扩展头信息大小
                const extHeaderSize = this.findHeaderEnd(buffer, offset);
                const extHeaderBlocks = Math.ceil(extHeaderSize / 2880);
                const headerEnd = offset + extHeaderBlocks * 2880;
                
                console.log(`扩展头大小: ${extHeaderSize} 字节, ${extHeaderBlocks} 个块, 结束于 ${headerEnd}`);
                
                // 计算扩展数据大小
                let extDataSize = 0;
                const xtensionItem = extHeader.getItem('XTENSION');
                if (xtensionItem) {
                    const hduType = xtensionItem.value.trim().toUpperCase();
                    if (hduType === 'BINTABLE' || hduType === 'TABLE') {
                        const naxis1 = extHeader.getItem('NAXIS1')?.value || 0;
                        const naxis2 = extHeader.getItem('NAXIS2')?.value || 0;
                        extDataSize = naxis1 * naxis2;
                        console.log(`按${hduType}类型计算扩展数据大小: ${extDataSize} 字节, NAXIS1=${naxis1}, NAXIS2=${naxis2}`);
                    }
                }
                
                // 计算对齐后的数据大小
                const alignedDataSize = Math.ceil(extDataSize / 2880) * 2880;
                const dataEnd = headerEnd + alignedDataSize;
                console.log(`数据大小: ${extDataSize} 字节, 对齐后: ${alignedDataSize} 字节, 结束于 ${dataEnd}`);
                
                // 解析扩展数据
                let extData: Float32Array | null = null;
                if (extDataSize > 0) {
                    console.log('解析扩展数据...');
                    if (xtensionItem?.value.trim() === 'BINTABLE') {
                        console.log('检测到BINTABLE，使用二进制表解析方法');
                        extData = this.parseBinaryTable(buffer, headerEnd, extHeader, buffer.length - headerEnd);
                    }
                }
                
                console.log(`扩展 HDU #${extCount + 1} 数据解析结果: `, extData ? `长度=${extData.length}, 示例数据=${extData.slice(0, Math.min(10, extData.length))}` : 'null');
                
                // 创建扩展HDU
                const extHDU = new FITSHDU(extHeader, extData);
                fits.hdus.push(extHDU);
                
                // 更新偏移量到下一个HDU
                offset = dataEnd;
                
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
            return new Float32Array(0);
        }
        
        // 【新增日志】输出解析的数据长度和部分样本值
        console.log(`parseData: 解析完成, bitpix=${bitpix}, naxis=${naxis}, dataSize=${dataSize}, data长度=${data.length}, 示例数据=`, data.slice(0, Math.min(10, data.length)));
        
        return data;
    }

    // 新的方法用于解析二进制表格数据
    private parseBinaryTable(buffer: Uint8Array, offset: number, header: FITSHeader, availableBytes: number): Float32Array {
        console.log('开始解析二进制表格数据');
        console.log('头信息项:', header.getAllItems());
        
        const naxis1 = header.getItem('NAXIS1')?.value;
        const naxis2 = header.getItem('NAXIS2')?.value;
        const tfields = header.getItem('TFIELDS')?.value;
        const tform1 = header.getItem('TFORM1')?.value;
        
        console.log(`NAXIS1 = ${naxis1}, NAXIS2 = ${naxis2}, TFIELDS = ${tfields}, TFORM1 = ${tform1}`);
        
        if (!naxis1 || !naxis2) {
            console.error('二进制表格缺少 NAXIS1 或 NAXIS2');
            return new Float32Array(0);
        }
        
        const rowLength = naxis1; // 每行字节数
        const numRows = naxis2;
        console.log(`行长度 = ${rowLength} 字节, 行数 = ${numRows}`);
        
        // 计算实际需要的数据大小
        const rawDataSize = rowLength * numRows;
        console.log(`计算数据大小: 原始=${rawDataSize}字节, 可用=${availableBytes}字节`);
        
        // 检查数据大小是否足够
        const availableRows = Math.floor(availableBytes / rowLength);
        const actualRows = Math.min(numRows, availableRows);
        console.log(`实际可处理行数: ${actualRows} (${(actualRows/numRows*100).toFixed(1)}%)`);
        
        // 获取列信息
        const columnFormats = [];
        let currentOffset = 0;
        for (let i = 1; i <= tfields; i++) {
            const tform = header.getItem(`TFORM${i}`)?.value;
            const ttype = header.getItem(`TTYPE${i}`)?.value;
            console.log(`列 ${i}: TFORM=${tform}, TTYPE=${ttype}`);
            if (!tform) continue;
            
            let byteSize = 0;
            let repeat = 1;
            
            // 解析TFORM格式，例如 '1D' 或 'D'
            const match = tform.match(/^(\d+)?([A-Z])$/);
            if (match) {
                repeat = parseInt(match[1]) || 1;
                const format = match[2];
                
                if (format === 'D') byteSize = 8;      // 双精度浮点数
                else if (format === 'E') byteSize = 4; // 单精度浮点数
                else if (format === 'J') byteSize = 4; // 32位整数
                else if (format === 'I') byteSize = 2; // 16位整数
                else if (format === 'B') byteSize = 1; // 8位整数
            }
            
            const totalSize = byteSize * repeat;
            console.log(`列 ${i} 格式解析: repeat=${repeat}, byteSize=${byteSize}, totalSize=${totalSize}`);
            
            if (byteSize > 0) {
                columnFormats.push({
                    format: tform,
                    byteSize: byteSize,
                    repeat: repeat,
                    totalSize: totalSize,
                    offset: currentOffset,
                    type: ttype
                });
                currentOffset += totalSize;
            }
        }
        
        console.log('列格式信息:', columnFormats);
        
        // 验证行长度
        if (currentOffset > rowLength) {
            console.error(`计算的总字节数(${currentOffset})大于行长度(${rowLength})`);
            return new Float32Array(0);
        }
        
        // 我们只关注第一列的数据
        const firstColumn = columnFormats[0];
        if (!firstColumn) {
            console.error('未找到有效的列格式信息');
            return new Float32Array(0);
        }
        
        const result = new Float32Array(actualRows * firstColumn.repeat);
        console.log(`创建结果数组，长度 = ${result.length}`);
        
        try {
            // 创建一个新的视图，使用实际的数据大小
            const dataView = new DataView(buffer.buffer, buffer.byteOffset + offset, availableBytes);
            console.log(`创建 DataView: offset = ${offset}, dataSize = ${availableBytes}`);
            
            // 读取前几个值进行调试
            console.log('前5行的原始字节:');
            for (let i = 0; i < Math.min(5, actualRows); i++) {
                const rowOffset = i * rowLength;
                const valueOffset = rowOffset + firstColumn.offset;
                
                const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset + valueOffset, firstColumn.totalSize);
                console.log(`Row ${i}: [${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
                
                // 读取该行的所有重复值
                for (let j = 0; j < firstColumn.repeat; j++) {
                    const elementOffset = valueOffset + j * firstColumn.byteSize;
                    let value: number;
                    
                    if (firstColumn.format.includes('D')) {
                        value = dataView.getFloat64(elementOffset, false);
                    } else if (firstColumn.format.includes('E')) {
                        value = dataView.getFloat32(elementOffset, false);
                    } else if (firstColumn.format.includes('J')) {
                        value = dataView.getInt32(elementOffset, false);
                    } else if (firstColumn.format.includes('I')) {
                        value = dataView.getInt16(elementOffset, false);
                    } else if (firstColumn.format.includes('B')) {
                        value = dataView.getUint8(elementOffset);
                    } else {
                        throw new Error(`不支持的数据格式: ${firstColumn.format}`);
                    }
                    
                    result[i * firstColumn.repeat + j] = value;
                    console.log(`Row ${i}, Element ${j}: ${value}`);
                }
            }
            
            // 继续处理剩余数据
            console.log('开始处理剩余数据...');
            let processedRows = 0;
            
            for (let row = 0; row < actualRows; row++) {
                const rowOffset = row * rowLength;
                const valueOffset = rowOffset + firstColumn.offset;
                
                // 读取该行的所有重复值
                for (let j = 0; j < firstColumn.repeat; j++) {
                    const elementOffset = valueOffset + j * firstColumn.byteSize;
                    
                    if (elementOffset + firstColumn.byteSize > availableBytes) {
                        console.warn(`警告：在处理第 ${row} 行第 ${j} 个元素时达到数据边界，提前结束`);
                        break;
                    }
                    
                    let value: number;
                    if (firstColumn.format.includes('D')) {
                        value = dataView.getFloat64(elementOffset, false);
                    } else if (firstColumn.format.includes('E')) {
                        value = dataView.getFloat32(elementOffset, false);
                    } else if (firstColumn.format.includes('J')) {
                        value = dataView.getInt32(elementOffset, false);
                    } else if (firstColumn.format.includes('I')) {
                        value = dataView.getInt16(elementOffset, false);
                    } else if (firstColumn.format.includes('B')) {
                        value = dataView.getUint8(elementOffset);
                    } else {
                        throw new Error(`不支持的数据格式: ${firstColumn.format}`);
                    }
                    
                    result[row * firstColumn.repeat + j] = value;
                }
                
                processedRows++;
                
                // 每处理10万行输出一次进度
                if (processedRows % 100000 === 0) {
                    console.log(`已处理 ${processedRows} 行，完成 ${(processedRows / actualRows * 100).toFixed(1)}%`);
                }
            }
            
            console.log(`数据解析完成，结果数组长度 = ${result.length}`);
            console.log('结果数组前10个值:', Array.from(result.slice(0, 10)));
            
            return result;
        } catch (error) {
            console.error('解析二进制表格数据时出错:', error);
            if (error instanceof Error) {
                console.error('错误详情:', error.message);
                console.error('调用栈:', error.stack);
            }
            return new Float32Array(0);
        }
    }

    // 验证FITS文件头
    private validateFITSHeader(buffer: Uint8Array): boolean {
        // 检查SIMPLE关键字
        const header = this.readLine(buffer, 0);
        if (!header.startsWith('SIMPLE  =')) {
            console.error('FITS头部验证失败：缺少SIMPLE关键字');
            return false;
        }

        // 检查SIMPLE值是否为T
        if (header[29] !== 'T') {
            console.error('FITS头部验证失败：SIMPLE值不是T');
            return false;
        }

        // 检查BITPIX
        const bitpixLine = this.readLine(buffer, FLEN_CARD);
        if (!bitpixLine.startsWith('BITPIX')) {
            console.error('FITS头部验证失败：缺少BITPIX关键字');
            return false;
        }

        // 检查NAXIS
        const naxisLine = this.readLine(buffer, FLEN_CARD * 2);
        if (!naxisLine.startsWith('NAXIS')) {
            console.error('FITS头部验证失败：缺少NAXIS关键字');
            return false;
        }

        return true;
    }

    // 验证主HDU
    private validatePrimaryHDU(header: FITSHeader): boolean {
        // 验证必需的关键字
        const requiredKeys = ['SIMPLE', 'BITPIX', 'NAXIS'];
        for (const key of requiredKeys) {
            if (!header.getItem(key)) {
                console.error(`主HDU验证失败：缺少${key}关键字`);
                return false;
            }
        }

        // 验证BITPIX值
        const bitpix = header.getItem('BITPIX')?.value;
        const validBitpix = [8, 16, 32, 64, -32, -64];
        if (!validBitpix.includes(bitpix)) {
            console.error(`主HDU验证失败：无效的BITPIX值 ${bitpix}`);
            return false;
        }

        // 验证NAXIS值
        const naxis = header.getItem('NAXIS')?.value;
        if (typeof naxis !== 'number' || naxis < 0 || naxis > 999) {
            console.error(`主HDU验证失败：无效的NAXIS值 ${naxis}`);
            return false;
        }

        return true;
    }

    // 验证扩展HDU
    private validateExtensionHDU(header: FITSHeader): HDUType | null {
        const xtension = header.getItem('XTENSION')?.value;
        if (!xtension) {
            console.error('扩展HDU验证失败：缺少XTENSION关键字');
            return null;
        }

        // 确定HDU类型
        const xtensionValue = xtension.trim().toUpperCase();
        switch (xtensionValue) {
            case 'IMAGE':
                return HDUType.IMAGE_HDU;
            case 'TABLE':
                return HDUType.ASCII_TBL;
            case 'BINTABLE':
                return HDUType.BINARY_TBL;
            default:
                console.error(`扩展HDU验证失败：未知的XTENSION类型 ${xtensionValue}`);
                return null;
        }
    }

    /**
     * 读取并验证HDU头部
     */
    private ffrhdu(hdutype: HDUType, status: number): number {
        if (!this.fptr) {
            return NOT_FITS;
        }

        // 使用全局常量FLEN_CARD
        let card = new Uint8Array(FLEN_CARD);

        // 读取第一个关键字
        this.ffgcrd("SIMPLE", card, status);

        // 检查是否为SIMPLE或XTENSION
        if (this.strncmp(card, "SIMPLE", 6) === 0) {
            // 主HDU验证
            hdutype = HDUType.IMAGE_HDU;
            
            // 验证SIMPLE = T
            if (card[29] !== 'T'.charCodeAt(0)) {
                return NOT_FITS;
            }
            
            // 验证BITPIX
            this.ffgcrd("BITPIX", card, status);
            // 验证BITPIX值...
            
            // 验证NAXIS
            this.ffgcrd("NAXIS", card, status);
            // 验证NAXIS值...
            
        } else if (this.strncmp(card, "XTENSION", 8) === 0) {
            // 扩展HDU验证
            if (this.strncmp(card.slice(10), "IMAGE   ", 9) === 0) {
                hdutype = HDUType.IMAGE_HDU;
            } else if (this.strncmp(card.slice(10), "TABLE   ", 9) === 0) {
                hdutype = HDUType.ASCII_TBL;  
            } else if (this.strncmp(card.slice(10), "BINTABLE", 9) === 0) {
                hdutype = HDUType.BINARY_TBL;
            } else {
                return NOT_FITS;
            }
        } else {
            return NOT_FITS;
        }

        return status;
    }

    /**
     * 打开FITS文件
     */
    private ffopen(buffer: Uint8Array): number {
        let status = 0;

        // 分配fitsfile结构
        this.fptr = {
            Fptr: {
                filehandle: 0,
                driver: 0,
                filename: "memory",
                filesize: buffer.length,
                writemode: 0,
                datastart: -1,
                iobuffer: buffer,
                headstart: new Array(1001).fill(0)
            }
        };

        return status;
    }

    // 辅助函数
    private strncmp(buf1: Uint8Array, str2: string, n: number): number {
        const buf2 = new TextEncoder().encode(str2);
        for (let i = 0; i < n; i++) {
            if (buf1[i] !== buf2[i]) {
                return buf1[i] - buf2[i];
            }
        }
        return 0;
    }

    private ffgcrd(keyname: string, card: Uint8Array, status: number): number {
        if (!this.fptr) {
            return NOT_FITS;
        }

        // 在iobuffer中查找关键字
        const buffer = this.fptr.Fptr.iobuffer;
        let found = false;
        
        for (let i = 0; i < buffer.length; i += FLEN_CARD) {
            const line = buffer.slice(i, i + FLEN_CARD);
            if (this.strncmp(line, keyname, keyname.length) === 0) {
                card.set(line);
                found = true;
                break;
            }
        }

        return found ? status : NOT_FITS;
    }
} 