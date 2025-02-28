/**
 * FITS文件解析器
 * 用于解析FITS文件并提取头信息和数据
 */

import { HDUType, TableData } from './models/FITSDataManager';
import { ColumnData } from './models/FITSDataManager';

// 常量定义
const READONLY = 0;
const READWRITE = 1;
const MAX_DIMS = 999;
const FLEN_KEYWORD = 72;
const FLEN_VALUE = 72;
const FLEN_COMMENT = 72;
const FLEN_CARD = 80;      // 卡片长度
const MAX_PREFIX_LEN = 20; // 文件类型前缀最大长度
const NOT_FITS = 108;      // 错误代码：非FITS文件
const FITS_BLOCK_SIZE = 2880; // FITS块大小

// FITS文件类型
enum FITSHDUType {
    IMAGE_HDU = 0,
    ASCII_TBL = 1,
    BINARY_TBL = 2
}

// 数据类型定义
enum DataType {
    BYTE_IMG = 8,
    SHORT_IMG = 16,
    LONG_IMG = 32,
    FLOAT_IMG = -32,
    DOUBLE_IMG = -64
}

// 压缩方法
enum CompressionType {
    RICE_1 = 11,
    GZIP_1 = 21,
    PLIO_1 = 31,
    HCOMPRESS_1 = 41
}

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
        public data: Float32Array | null = null,
        public fileInfo: {
            headerStart: number,    // 头部起始字节位置
            dataStart: number,      // 数据块起始字节位置
            dataSize: number,       // 数据大小（包含填充）
            headerSize: number      // 头部大小（包含填充）
        } = {
            headerStart: 0,
            dataStart: 0,
            dataSize: 0,
            headerSize: 0
        }
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

class FitsBuffer {
    private buffer: ArrayBuffer;
    private view: DataView;
    private position: number = 0;

    constructor(buffer: Uint8Array) {
        this.buffer = buffer.buffer;
        this.view = new DataView(this.buffer, buffer.byteOffset, buffer.byteLength);
    }

    public readInt8(): number {
        const value = this.view.getInt8(this.position);
        this.position += 1;
        return value;
    }

    public readInt16(): number {
        const value = this.view.getInt16(this.position, false); // FITS使用大端字节序
        this.position += 2;
        return value;
    }

    public readInt32(): number {
        const value = this.view.getInt32(this.position, false);
        this.position += 4;
        return value;
    }

    public readFloat32(): number {
        const value = this.view.getFloat32(this.position, false);
        this.position += 4;
        return value;
    }

    public readFloat64(): number {
        const value = this.view.getFloat64(this.position, false);
        this.position += 8;
        return value;
    }

    public readString(length: number): string {
        const bytes = new Uint8Array(this.buffer, this.view.byteOffset + this.position, length);
        this.position += length;
        return new TextDecoder().decode(bytes).trim();
    }

    public seek(position: number): void {
        this.position = position;
    }

    public getPosition(): number {
        return this.position;
    }

    public getBuffer(): ArrayBuffer {
        return this.buffer;
    }

    public getView(): DataView {
        return this.view;
    }
}

// FITS文件解析器
export class FITSParser {
    private buffer: FitsBuffer | null = null;
    private header: FITSHeader | null = null;

    // 解析FITS文件
    parseFITS(buffer: Uint8Array): FITS {
        console.log('开始解析FITS文件...');
        const fits = new FITS();
        
        // 检查FITS文件头
        if (buffer.length < FITS_BLOCK_SIZE) {
            throw new Error('无效的FITS文件格式');
        }
        
        this.buffer = new FitsBuffer(buffer);
        
        // 验证FITS文件头
        if (!this.validateFITSHeader()) {
            throw new Error('无效的FITS文件格式');
        }
        
        // 重置偏移量，确保从文件开头开始计算
        let offset = 0;
        let currentOffset = 0;  // 用于跟踪实际的文件位置
        
        // 解析主头信息
        console.log('解析主头信息...');
        const primaryHeader = this.parseHeader(offset);
        
        // 验证主HDU
        if (!this.validatePrimaryHDU(primaryHeader)) {
            throw new Error('无效的主HDU格式');
        }
        
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
        
        // 计算头信息块数和数据块数
        const headerSize = this.findHeaderEnd(offset);
        const headerBlocks = Math.ceil(headerSize / FITS_BLOCK_SIZE);
        const headerEnd = headerBlocks * FITS_BLOCK_SIZE;
        currentOffset = headerEnd;  // 更新当前位置到头部结束
        
        console.log(`头信息大小: ${headerSize} 字节, ${headerBlocks} 个块, 结束于 ${headerEnd}`);
        
        // 计算数据块数并调整偏移量
        const dataBlocks = Math.ceil(dataSize / FITS_BLOCK_SIZE);
        const alignedDataSize = dataBlocks * FITS_BLOCK_SIZE;
        const dataEnd = headerEnd + alignedDataSize;
        currentOffset = dataEnd;  // 更新当前位置到数据结束
        
        console.log(`数据块数: ${dataBlocks}, 数据结束于 ${dataEnd}`);
        
        // 解析主HDU数据（如果有）
        let data: Float32Array | null = null;
        if (dataSize > 0) {
            console.log('解析主数据...');
            data = this.parseData(headerEnd, primaryHeader);
        }
        
        // 创建主HDU，包含文件位置信息
        const primaryHDU = new FITSHDU(primaryHeader, data, {
            headerStart: offset,
            dataStart: headerEnd,
            dataSize: alignedDataSize,
            headerSize: headerEnd - offset
        });
        fits.hdus.push(primaryHDU);
        
        // 更新偏移量到下一个HDU的开始位置
        offset = currentOffset;
        console.log('主HDU解析完成，当前偏移量:', offset);
        
        // 解析扩展HDU
        let extCount = 0;
        const maxExtensions = 10;
        
        while (offset < buffer.length && extCount < maxExtensions) {
            try {
                console.log(`解析扩展 #${extCount + 1}...`);
                console.log(`当前偏移量: ${offset}`);
                
                // 检查是否还有足够的数据
                if (buffer.length - offset < FITS_BLOCK_SIZE) {
                    console.log('剩余数据不足一个块，停止解析');
                    break;
                }
                
                this.buffer.seek(offset);
                
                // 检查是否是有效的扩展头
                if (!this.isValidExtension()) {
                    console.log('未找到有效的扩展头，停止解析');
                    break;
                }
                
                // 解析扩展头信息
                const extHeader = this.parseHeader(offset);
                console.log(`扩展 HDU #${extCount + 1} 头信息关键字: `, extHeader.getAllItems().map(item => item.key));
                
                // 检查是否找到END关键字
                if (extHeader.getAllItems().length === 0) {
                    console.log('扩展头为空，停止解析');
                    break;
                }
                
                fits.headers.push(extHeader);
                
                // 计算扩展头信息大小
                const extHeaderSize = this.findHeaderEnd(offset);
                const extHeaderBlocks = Math.ceil(extHeaderSize / FITS_BLOCK_SIZE);
                const headerSize = extHeaderBlocks * FITS_BLOCK_SIZE;
                const headerEnd = offset + headerSize;
                
                console.log(`扩展头大小计算详情:`);
                console.log(`- 实际头部大小（包括END卡片）: ${extHeaderSize} 字节`);
                console.log(`- 需要的2880字节块数: ${extHeaderBlocks}`);
                console.log(`- 对齐后的头部大小: ${headerSize} 字节`);
                console.log(`- 头部起始位置: ${offset}`);
                console.log(`- 头部结束位置: ${offset + extHeaderSize}`);
                console.log(`- 数据起始位置: ${headerEnd}`);
                
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
                const dataBlocks = Math.ceil(extDataSize / FITS_BLOCK_SIZE);
                const alignedDataSize = dataBlocks * FITS_BLOCK_SIZE;
                const dataEnd = headerEnd + alignedDataSize;
                console.log(`数据大小计算:`);
                console.log(`- 原始数据大小: ${extDataSize} 字节`);
                console.log(`- 数据块数: ${dataBlocks}`);
                console.log(`- 对齐后数据大小: ${alignedDataSize} 字节`);
                console.log(`- 数据结束位置: ${dataEnd}`);
                
                // 解析扩展数据
                let extData: Float32Array | null = null;
                if (extDataSize > 0) {
                    console.log('解析扩展数据...');
                    if (xtensionItem?.value.trim() === 'BINTABLE') {
                        console.log('检测到BINTABLE，使用二进制表解析方法');
                        extData = this.parseBinaryTable(headerEnd, extHeader, buffer.length - headerEnd);
                    }
                }
                
                console.log(`扩展 HDU #${extCount + 1} 数据解析结果: `, extData ? `长度=${extData.length}, 示例数据=${extData.slice(0, Math.min(10, extData.length))}` : 'null');
                
                // 创建扩展HDU，包含文件位置信息
                const extHDU = new FITSHDU(extHeader, extData, {
                    headerStart: offset,      // 扩展HDU头部开始位置
                    dataStart: headerEnd,     // 扩展HDU数据开始位置
                    dataSize: alignedDataSize,// 扩展HDU数据大小（包含填充）
                    headerSize: headerSize    // 扩展HDU头部大小（包含填充）
                });
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

    private validateFITSHeader(): boolean {
        if (!this.buffer) return false;
        
        // 检查SIMPLE关键字
        const header = this.buffer.readString(FLEN_CARD);
        if (!header.startsWith('SIMPLE  =')) {
            console.error('FITS头部验证失败：缺少SIMPLE关键字');
            return false;
        }

        // 检查SIMPLE值是否为T
        if (header[29] !== 'T') {
            console.error('FITS头部验证失败：SIMPLE值不是T');
            return false;
        }

        this.buffer.seek(FLEN_CARD);
        
        // 检查BITPIX
        const bitpixLine = this.buffer.readString(FLEN_CARD);
        if (!bitpixLine.startsWith('BITPIX')) {
            console.error('FITS头部验证失败：缺少BITPIX关键字');
            return false;
        }

        this.buffer.seek(FLEN_CARD * 2);
        
        // 检查NAXIS
        const naxisLine = this.buffer.readString(FLEN_CARD);
        if (!naxisLine.startsWith('NAXIS')) {
            console.error('FITS头部验证失败：缺少NAXIS关键字');
            return false;
        }

        return true;
    }

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
        if (typeof naxis !== 'number' || naxis < 0 || naxis > MAX_DIMS) {
            console.error(`主HDU验证失败：无效的NAXIS值 ${naxis}`);
            return false;
        }

        return true;
    }

    private isValidExtension(): boolean {
        if (!this.buffer) return false;
        const line = this.buffer.readString(FLEN_CARD);
        return line.startsWith('XTENSION');
    }

    private findHeaderEnd(startOffset: number): number {
        if (!this.buffer) return 0;
        
        this.buffer.seek(startOffset);
        const maxLines = 1000; // 防止无限循环
        let lineCount = 0;
        
        while (lineCount < maxLines) {
            const line = this.buffer.readString(FLEN_CARD);
            lineCount++;
            
            if (line.startsWith('END')) {
                // 返回实际的头部大小（包括END卡片）
                return lineCount * FLEN_CARD;
            }
        }
        
        return 0;
    }

    private parseHeader(offset: number): FITSHeader {
        if (!this.buffer) throw new Error('Buffer not initialized');
        
        const header = new FITSHeader();
        this.buffer.seek(offset);
        const maxLines = 1000;
        let lineCount = 0;
        
        while (lineCount < maxLines) {
            const line = this.buffer.readString(FLEN_CARD);
            lineCount++;
            
            if (line.startsWith('END')) {
                break;
            }
            
            const item = this.parseHeaderItem(line);
            if (item) {
                header.addItem(item.key, item.value, item.comment);
            }
        }
        
        return header;
    }

    private parseHeaderItem(line: string): FITSHeaderItem | null {
        const keyValueMatch = line.match(/^([A-Z0-9_-]+)\s*=\s*(.+?)(?:\s*\/\s*(.*))?$/);
        
        if (keyValueMatch) {
            const key = keyValueMatch[1].trim();
            let valueStr = keyValueMatch[2].trim();
            const comment = keyValueMatch[3]?.trim();
            
            let value: any;
            
            if (valueStr.startsWith("'") && valueStr.includes("'")) {
                const endQuotePos = valueStr.lastIndexOf("'");
                value = valueStr.substring(1, endQuotePos).trim();
            } else if (valueStr === 'T') {
                value = true;
            } else if (valueStr === 'F') {
                value = false;
            } else {
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

    private parseData(offset: number, header: FITSHeader): Float32Array {
        if (!this.buffer) throw new Error('Buffer not initialized');
        
        const bitpix = header.getItem('BITPIX')?.value || 0;
        const naxis = header.getItem('NAXIS')?.value || 0;
        
        let dataSize = 1;
        for (let i = 1; i <= naxis; i++) {
            const axisSize = header.getItem(`NAXIS${i}`)?.value || 0;
            dataSize *= axisSize;
        }
        
        const data = new Float32Array(dataSize);
        this.buffer.seek(offset);
        
        const bzero = header.getItem('BZERO')?.value || 0;
        const bscale = header.getItem('BSCALE')?.value || 1;
        
        try {
            for (let i = 0; i < dataSize; i++) {
                let value = 0;
                
                switch (bitpix) {
                    case DataType.BYTE_IMG:
                        value = this.buffer.readInt8();
                        break;
                    case DataType.SHORT_IMG:
                        value = this.buffer.readInt16();
                        break;
                    case DataType.LONG_IMG:
                        value = this.buffer.readInt32();
                        break;
                    case DataType.FLOAT_IMG:
                        value = this.buffer.readFloat32();
                        break;
                    case DataType.DOUBLE_IMG:
                        value = this.buffer.readFloat64();
                        break;
                    default:
                        throw new Error(`不支持的BITPIX值: ${bitpix}`);
                }
                
                data[i] = value * bscale + bzero;
            }
        } catch (error) {
            console.error('解析数据时出错:', error);
            return new Float32Array(0);
        }
        
        console.log(`parseData: 解析完成, bitpix=${bitpix}, naxis=${naxis}, dataSize=${dataSize}, data长度=${data.length}, 示例数据=`, data.slice(0, Math.min(10, data.length)));
        
        return data;
    }

    private parseBinaryTable(offset: number, header: FITSHeader, availableBytes: number): Float32Array {
        if (!this.buffer) throw new Error('Buffer not initialized');
        
        console.log('开始解析二进制表格数据');
        console.log('数据起始偏移量:', offset);
        console.log('可用字节数:', availableBytes);
        
        const naxis1 = header.getItem('NAXIS1')?.value;
        const naxis2 = header.getItem('NAXIS2')?.value;
        const tfields = header.getItem('TFIELDS')?.value;
        
        console.log(`NAXIS1 (行长度) = ${naxis1}, NAXIS2 (行数) = ${naxis2}, TFIELDS (字段数) = ${tfields}`);
        
        if (!naxis1 || !naxis2 || !tfields) {
            console.error('二进制表格缺少必要的头信息');
            return new Float32Array(0);
        }

        // 解析列信息
        const columns = new Map<string, {
            name: string;
            format: string;
            unit: string;
            dataType: string;
            repeatCount: number;
            byteOffset: number;
            byteSize: number;
            data: Float32Array | Float64Array | Int8Array | Int16Array | Int32Array;
        }>();

        let currentOffset = 0;
        
        // 首先收集所有列的信息
        for (let i = 1; i <= tfields; i++) {
            const tform = header.getItem(`TFORM${i}`)?.value;
            const ttype = header.getItem(`TTYPE${i}`)?.value || `COL${i}`;
            const tunit = header.getItem(`TUNIT${i}`)?.value || '';
            
            if (!tform) {
                console.error(`缺少TFORM${i}定义`);
                continue;
            }
            
            // 解析TFORM格式：rTa
            const match = tform.match(/^(\d*)([A-Z])/);
            if (!match) {
                console.error(`无效的TFORM${i}格式: ${tform}`);
                continue;
            }
            
            const repeatCount = match[1] ? parseInt(match[1]) : 1;
            const dataType = match[2];
            
            // 确定数据类型的字节大小和对应的TypedArray
            let byteSize: number;
            let ArrayType: any;
            
            switch (dataType) {
                case 'B':  // Unsigned byte
                    byteSize = 1;
                    ArrayType = Int8Array;
                    break;
                case 'I':  // 16-bit integer
                    byteSize = 2;
                    ArrayType = Int16Array;
                    break;
                case 'J':  // 32-bit integer
                    byteSize = 4;
                    ArrayType = Int32Array;
                    break;
                case 'E':  // 32-bit floating point
                    byteSize = 4;
                    ArrayType = Float32Array;
                    break;
                case 'D':  // 64-bit floating point
                    byteSize = 8;
                    ArrayType = Float64Array;
                    break;
                default:
                    console.warn(`不支持的数据类型: ${dataType}`);
                    continue;
            }

            // 为每列创建适当大小的数组
            const arraySize = naxis2 * repeatCount;
            const columnData = new ArrayType(arraySize);

            columns.set(ttype, {
                name: ttype,
                format: tform,
                unit: tunit,
                dataType,
                repeatCount,
                byteOffset: currentOffset,
                byteSize,
                data: columnData
            });

            currentOffset += byteSize * repeatCount;
        }

        try {
            // 读取每一行的数据
            for (let row = 0; row < naxis2; row++) {
                const rowStart = offset + row * naxis1;

                // 处理每一列
                for (const [name, column] of columns) {
                    const colOffset = rowStart + column.byteOffset;
                    this.buffer.seek(colOffset);

                    // 读取该列在当前行的所有值
                    for (let r = 0; r < column.repeatCount; r++) {
                        const dataIndex = row * column.repeatCount + r;
                        
                        try {
                            let value: number;
                            switch (column.dataType) {
                                case 'D': value = this.buffer.readFloat64(); break;
                                case 'E': value = this.buffer.readFloat32(); break;
                                case 'J': value = this.buffer.readInt32(); break;
                                case 'I': value = this.buffer.readInt16(); break;
                                case 'B': value = this.buffer.readInt8(); break;
                                default: value = 0;
                            }
                            
                            if (dataIndex < column.data.length) {
                                column.data[dataIndex] = value;
                            }
                        } catch (error) {
                            console.error(`读取数据出错: 列=${name}, 行=${row}, 重复=${r}`, error);
                            throw error;
                        }
                    }
                }

                // 输出进度
                if (row % 1000 === 0 || row === naxis2 - 1) {
                    console.log(`处理进度: ${((row + 1) / naxis2 * 100).toFixed(1)}%`);
                }
            }

            // 输出每列的一些示例数据
            for (const [name, column] of columns) {
                console.log(`列 ${name} 的前10个数据:`, Array.from(column.data.slice(0, 10)));
            }

            // 创建一个包含所有列数据的Map
            const columnsData = new Map<string, ColumnData>();
            for (const [name, column] of columns) {
                columnsData.set(name, {
                    name: column.name,
                    data: column.data,
                    format: column.format,
                    unit: column.unit,
                    dataType: column.dataType,
                    repeatCount: column.repeatCount
                });
            }

            // 为了保持向后兼容，我们仍然返回第一列数据作为主数据
            const firstColumn = Array.from(columns.values())[0];
            if (!firstColumn) {
                return new Float32Array(0);
            }

            // 将第一列数据转换为Float32Array并返回，同时在data属性中包含所有列数据
            const result = new Float32Array(firstColumn.data);
            Object.defineProperty(result, 'columns', {
                value: columnsData,
                enumerable: true,
                configurable: true,
                writable: true
            });

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
} 