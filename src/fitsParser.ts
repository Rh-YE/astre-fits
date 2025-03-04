/**
 * FITS file parser | FITS文件解析器
 * Used to parse FITS files and extract header information and data | 用于解析FITS文件并提取头信息和数据
 */

import { HDUType, TableData } from './models/FITSDataManager';
import { ColumnData as ImportedColumnData } from './models/FITSDataManager';

// Base column data interface | 基础列数据接口
export interface BaseColumnData {
    name: string;
    format: string;
    unit: string;
    dataType: string;
    repeatCount: number;
}

// Numeric column data interface | 数值类型列数据接口
export interface NumericColumnData extends BaseColumnData {
    data: Float32Array | Float64Array | Int8Array | Int16Array | Int32Array;
    getValue(index: number): number | number[];
}

// String column data interface | 字符串类型列数据接口
export interface StringColumnData extends BaseColumnData {
    data: string[];  // Store string array directly | 直接存储字符串数组
    getValue(index: number): string;
}

// Boolean column data interface | 布尔类型列数据接口
export interface BooleanColumnData extends BaseColumnData {
    data: boolean[] | boolean[][];  // Support 1D or 2D arrays | 修改为支持一维或二维数组
    getValue(index: number): boolean;
}

// Unified column data type | 统一的列数据类型
export type ColumnData = NumericColumnData | StringColumnData | BooleanColumnData;

// Constants definition | 常量定义
const READONLY = 0;
const READWRITE = 1;
const MAX_DIMS = 999;
const FLEN_KEYWORD = 72;
const FLEN_VALUE = 72;
const FLEN_COMMENT = 72;
const FLEN_CARD = 80;      // Card length | 卡片长度
const MAX_PREFIX_LEN = 20; // Maximum length of file type prefix | 文件类型前缀最大长度
const NOT_FITS = 108;      // Error code: not a FITS file | 错误代码：非FITS文件
const FITS_BLOCK_SIZE = 2880; // FITS block size | FITS块大小

// FITS file type | FITS文件类型
enum FITSHDUType {
    IMAGE_HDU = 0,
    ASCII_TBL = 1,
    BINARY_TBL = 2
}

// Data type definition | 数据类型定义
enum DataType {
    BYTE_IMG = 8,
    SHORT_IMG = 16,
    LONG_IMG = 32,
    FLOAT_IMG = -32,
    DOUBLE_IMG = -64
}

// Compression method | 压缩方法
enum CompressionType {
    RICE_1 = 11,
    GZIP_1 = 21,
    PLIO_1 = 31,
    HCOMPRESS_1 = 41
}

// FITS file header item | FITS文件头信息项
export interface FITSHeaderItem {
    key: string;
    value: any;
    comment?: string;
}

// FITS file header | FITS文件头信息
export class FITSHeader {
    private items: FITSHeaderItem[] = [];
    
    constructor() {}
    
    // Add header item | 添加头信息项
    addItem(key: string, value: any, comment?: string): void {
        this.items.push({ key, value, comment });
    }
    
    // Get header item | 获取头信息项
    getItem(key: string): FITSHeaderItem | undefined {
        return this.items.find(item => item.key === key);
    }
    
    // Get all header items | 获取所有头信息项
    getAllItems(): FITSHeaderItem[] {
        return this.items;
    }
}

// FITS file HDU (Header Data Unit) | FITS文件HDU（Header Data Unit）
export class FITSHDU {
    constructor(
        public header: FITSHeader,
        public data: Float32Array | null = null,
        public fileInfo: {
            headerStart: number,    // Header start byte position | 头部起始字节位置
            dataStart: number,      // Data block start byte position | 数据块起始字节位置
            dataSize: number,       // Data size (including padding) | 数据大小（包含填充）
            headerSize: number      // Header size (including padding) | 头部大小（包含填充）
        } = {
            headerStart: 0,
            dataStart: 0,
            dataSize: 0,
            headerSize: 0
        }
    ) {}
}

// FITS file | FITS文件
export class FITS {
    constructor(
        public headers: FITSHeader[] = [],
        public hdus: FITSHDU[] = []
    ) {}
    
    // Get HDU by index | 获取指定索引的HDU
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
        const value = this.view.getInt16(this.position, false); // FITS uses big-endian | FITS使用大端字节序
        this.position += 2;
        return value;
    }

    public readInt32(): number {
        const value = this.view.getInt32(this.position, false);
        this.position += 4;
        return value;
    }

    public readInt64(): number {
        // JavaScript cannot precisely represent integers over 53 bits | JavaScript不能精确表示超过53位的整数
        // Here we read high 32 bits and low 32 bits, then combine them | 这里我们读取高32位和低32位，然后组合它们
        const highBits = this.view.getInt32(this.position, false);
        const lowBits = this.view.getUint32(this.position + 4, false);
        this.position += 8;
        
        // Combine high 32 bits and low 32 bits | 组合高32位和低32位
        // Note: If value exceeds Number.MAX_SAFE_INTEGER (2^53-1), precision may be lost | 注意：如果数值超过Number.MAX_SAFE_INTEGER (2^53-1)，可能会丢失精度
        return highBits * Math.pow(2, 32) + lowBits;
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

// Modify interface definition to inherit all properties of Float32Array | 修改接口定义，继承Float32Array的所有属性
export interface TableResult extends Float32Array {
    columns: Map<string, ColumnData>;
    getColumnValue(columnName: string, index: number): string | number;
    isStringColumn(columnName: string): boolean;
}

// Modify column information interface definition | 修改列信息的接口定义
interface ColumnInfo {
    name: string;
    format: string;
    unit: string;
    dataType: string;
    repeatCount: number;
    byteOffset: number;
    byteSize: number;
    data: any;  // Use any type as it could be numeric or string array | 使用 any 类型，因为可能是数值数组或字符串数组
    isString: boolean;
}

// FITS file parser | FITS文件解析器
export class FITSParser {
    private buffer: FitsBuffer | null = null;
    private header: FITSHeader | null = null;
    // Parse FITS file | 解析FITS文件
    parseFITS(buffer: Uint8Array): FITS {
        // console.log('Starting to parse FITS file...');
        const fits = new FITS();
        
        // Check FITS file header | 检查FITS文件头
        if (buffer.length < FITS_BLOCK_SIZE) {
            throw new Error('Invalid FITS file format');
        }
        
        this.buffer = new FitsBuffer(buffer);
        
        // Validate FITS file header | 验证FITS文件头
        if (!this.validateFITSHeader()) {
            throw new Error('Invalid FITS file format');
        }
        
        // Reset offset to ensure starting from file beginning | 重置偏移量，确保从文件开头开始计算
        let offset = 0;
        let currentOffset = 0;  // Used to track actual file position | 用于跟踪实际的文件位置
        
        // Parse primary header information | 解析主头信息
        // console.log('Parsing primary header...');
        const primaryHeader = this.parseHeader(offset);
        
        // Validate primary HDU | 验证主HDU
        if (!this.validatePrimaryHDU(primaryHeader)) {
            throw new Error('Invalid primary HDU format');
        }
        
        fits.headers.push(primaryHeader);
        
        // Calculate data block size | 计算数据块大小
        const bitpix = primaryHeader.getItem('BITPIX')?.value || 0;
        const naxis = primaryHeader.getItem('NAXIS')?.value || 0;
        
        // console.log(`BITPIX: ${bitpix}, NAXIS: ${naxis}`);
        
        let dataSize = 0;
        if (naxis > 0) {
            dataSize = Math.abs(bitpix) / 8;
            
            for (let i = 1; i <= naxis; i++) {
                const axisSize = primaryHeader.getItem(`NAXIS${i}`)?.value || 0;
                dataSize *= axisSize;
                // console.log(`NAXIS${i}: ${axisSize}`);
            }
        }
        
        // console.log(`Data size: ${dataSize} bytes`);
        
        // Calculate header blocks and data blocks | 计算头信息块数和数据块数
        const headerSize = this.findHeaderEnd(offset);
        if (headerSize === 0) {
            throw new Error('Cannot find header end mark (END)');
        }
        const headerBlocks = Math.ceil(headerSize / FITS_BLOCK_SIZE);
        const alignedHeaderSize = headerBlocks * FITS_BLOCK_SIZE;
        const headerEnd = offset + alignedHeaderSize;
        currentOffset = headerEnd;  // Update current position to header end | 更新当前位置到头部结束

        // console.log(`Actual header size: ${headerSize} bytes`);
        // console.log(`Aligned header size: ${alignedHeaderSize} bytes (${headerBlocks} blocks)`);
        // console.log(`Data start position: ${headerEnd}`);
        
        // Calculate data blocks and adjust offset
        const dataBlocks = Math.ceil(dataSize / FITS_BLOCK_SIZE);
        const alignedDataSize = dataBlocks * FITS_BLOCK_SIZE;
        const dataEnd = headerEnd + alignedDataSize;
        currentOffset = dataEnd;  // Update current position to data end
        
        // console.log(`Data blocks: ${dataBlocks}, data ends at ${dataEnd}`);
        // Parse primary HDU data (if exists)
        let data: Float32Array | null = null;
        if (dataSize > 0) {
            // console.log('Parsing primary data...');
            data = this.parseData(headerEnd, primaryHeader);
        }
        
        // Create primary HDU with file position info
        const primaryHDU = new FITSHDU(primaryHeader, data, {
            headerStart: offset,
            dataStart: headerEnd,
            dataSize: alignedDataSize,
            headerSize: headerEnd - offset
        });
        fits.hdus.push(primaryHDU);
        
        // Update offset to start of next HDU
        offset = currentOffset;
        // console.log('Primary HDU parsing complete, current offset:', offset);
        
        // Parse extension HDUs
        let extCount = 0;
        const maxExtensions = 10;
        
        while (offset < buffer.length && extCount < maxExtensions) {
            try {
                // console.log(`Parsing extension #${extCount + 1}...`);
                // console.log(`Current offset: ${offset}`);
                
                // Check if enough data remains
                if (buffer.length - offset < FITS_BLOCK_SIZE) {
                    // console.log('Remaining data less than one block, stop parsing');
                    break;
                }
                
                this.buffer.seek(offset);
                
                // Check if valid extension header
                if (!this.isValidExtension()) {
                    // console.log('No valid extension header found, stop parsing');
                    break;
                }
                
                // Parse extension header
                const extHeader = this.parseHeader(offset);
                // console.log(`Extension HDU #${extCount + 1} header keywords:`, extHeader.getAllItems().map(item => item.key));
                
                // Check if END keyword found
                if (extHeader.getAllItems().length === 0) {
                    // console.log('Extension header empty, stop parsing');
                    break;
                }
                
                fits.headers.push(extHeader);
                
                // Calculate extension header size
                const extHeaderSize = this.findHeaderEnd(offset);
                if (extHeaderSize === 0) {
                    // console.log('Extension header end mark not found, stop parsing');
                    break;
                }

                // Calculate complete 2880-byte blocks for header
                const extHeaderBlocks = Math.ceil(extHeaderSize / FITS_BLOCK_SIZE);
                const alignedHeaderSize = extHeaderBlocks * FITS_BLOCK_SIZE;
                const headerEnd = offset + alignedHeaderSize;  // Extension data start position

                // console.log(`Extension header size details:`);
                // console.log(`- Actual header size (including END card): ${extHeaderSize} bytes`);
                // console.log(`- Required 2880-byte blocks: ${extHeaderBlocks}`);
                // console.log(`- Aligned header size: ${alignedHeaderSize} bytes`);
                // console.log(`- Header start position: ${offset}`);
                // console.log(`- Header end position: ${offset + extHeaderSize}`);
                // console.log(`- Data start position: ${headerEnd}`);
                
                // Calculate extension data size
                let extDataSize = 0;
                const xtensionItem = extHeader.getItem('XTENSION');
                if (xtensionItem) {
                    const hduType = xtensionItem.value.trim().toUpperCase();
                    if (hduType === 'BINTABLE' || hduType === 'TABLE') {
                        const naxis1 = extHeader.getItem('NAXIS1')?.value || 0;
                        const naxis2 = extHeader.getItem('NAXIS2')?.value || 0;
                        extDataSize = naxis1 * naxis2;
                        // console.log(`Calculate extension data size as ${hduType}: ${extDataSize} bytes, NAXIS1=${naxis1}, NAXIS2=${naxis2}`);
                    }
                }
                
                // Calculate aligned data size
                const dataBlocks = Math.ceil(extDataSize / FITS_BLOCK_SIZE);
                const alignedDataSize = dataBlocks * FITS_BLOCK_SIZE;
                const dataEnd = headerEnd + alignedDataSize;
                // console.log(`Data size calculation:`);
                // console.log(`- Original data size: ${extDataSize} bytes`);
                // console.log(`- Data blocks: ${dataBlocks}`);
                // console.log(`- Aligned data size: ${alignedDataSize} bytes`);
                // console.log(`- Data end position: ${dataEnd}`);
                
                // Parse extension data
                let extData: Float32Array | null = null;
                if (extDataSize > 0) {
                    // console.log('Parsing extension data...');
                    if (xtensionItem?.value.trim() === 'BINTABLE') {
                        // console.log('BINTABLE detected, using binary table parser');
                        extData = this.parseBinaryTable(headerEnd, extHeader, buffer.length - headerEnd);
                    } else if (xtensionItem?.value.trim() === 'TABLE') {
                        // console.log('ASCII table detected, using ASCII table parser');
                        extData = this.parseAsciiTable(headerEnd, extHeader, buffer.length - headerEnd);
                    }
                }
                
                // console.log(`Extension HDU #${extCount + 1} data parsing result: ${extData ? `length=${extData.length}, sample data=${extData.slice(0, Math.min(10, extData.length))}` : 'null'}`);
                
                // Create extension HDU with file position info
                const extHDU = new FITSHDU(extHeader, extData, {
                    headerStart: offset,      // Extension HDU header start position
                    dataStart: headerEnd,     // Extension HDU data start position
                    dataSize: alignedDataSize,// Extension HDU data size (with padding)
                    headerSize: alignedHeaderSize    // Extension HDU header size (with padding)
                });
                fits.hdus.push(extHDU);
                
                // Update offset to next HDU
                offset = dataEnd;
                
                extCount++;
            } catch (error) {
                console.error(`Error parsing extension #${extCount + 1}:`, error);
                break;
            }
        }
        
        // console.log(`Parsing complete, total ${fits.hdus.length} HDUs`);
        return fits;
    }

    private validateFITSHeader(): boolean {
        if (!this.buffer) return false;
        
        // Check SIMPLE keyword
        const header = this.buffer.readString(FLEN_CARD);
        if (!header.startsWith('SIMPLE  =')) {
            // console.error('FITS header validation failed: missing SIMPLE keyword');
            return false;
        }

        // Check if SIMPLE value is T
        if (header[29] !== 'T') {
            // console.error('FITS header validation failed: SIMPLE value is not T');
            return false;
        }

        this.buffer.seek(FLEN_CARD);
        
        // Check BITPIX
        const bitpixLine = this.buffer.readString(FLEN_CARD);
        if (!bitpixLine.startsWith('BITPIX')) {
            // console.error('FITS header validation failed: missing BITPIX keyword');
            return false;
        }

        this.buffer.seek(FLEN_CARD * 2);
        
        // Check NAXIS
        const naxisLine = this.buffer.readString(FLEN_CARD);
        if (!naxisLine.startsWith('NAXIS')) {
            // console.error('FITS header validation failed: missing NAXIS keyword');
            return false;
        }

        return true;
    }

    private validatePrimaryHDU(header: FITSHeader): boolean {
        // Validate required keywords
        const requiredKeys = ['SIMPLE', 'BITPIX', 'NAXIS'];
        for (const key of requiredKeys) {
            if (!header.getItem(key)) {
                console.error(`Primary HDU validation failed: missing ${key} keyword`);
                return false;
            }
        }

        // Validate BITPIX value
        const bitpix = header.getItem('BITPIX')?.value;
        const validBitpix = [8, 16, 32, 64, -32, -64];
        if (!validBitpix.includes(bitpix)) {
            console.error(`Primary HDU validation failed: invalid BITPIX value ${bitpix}`);
            return false;
        }

        // Validate NAXIS value
        const naxis = header.getItem('NAXIS')?.value;
        if (typeof naxis !== 'number' || naxis < 0 || naxis > MAX_DIMS) {
            console.error(`Primary HDU validation failed: invalid NAXIS value ${naxis}`);
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
        const maxLines = 10000; // Prevent infinite loop
        let lineCount = 0;
        
        while (lineCount < maxLines) {
            const line = this.buffer.readString(FLEN_CARD);
            lineCount++;
            
            if (line.startsWith('END')) {
                // Return actual header size (including END card)
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
                        throw new Error(`Unsupported BITPIX value: ${bitpix}`);
                }
                
                data[i] = value * bscale + bzero;
            }
        } catch (error) {
            console.error('Error parsing data:', error);
            return new Float32Array(0);
        }
        
        // console.log(`parseData: Parsing completed, bitpix=${bitpix}, naxis=${naxis}, dataSize=${dataSize}, data length=${data.length}, sample data=`, data.slice(0, Math.min(10, data.length)));
        
        return data;
    }

    private parseBinaryTable(offset: number, header: FITSHeader, availableBytes: number): TableResult {
        if (!this.buffer) throw new Error('Buffer not initialized');
        
        // console.log('Start parsing binary table data');
        // console.log('Data start offset:', offset);
        // console.log('Available bytes:', availableBytes);
        
        const naxis1 = header.getItem('NAXIS1')?.value;
        const naxis2 = header.getItem('NAXIS2')?.value;
        const tfields = header.getItem('TFIELDS')?.value;
        
        // console.log(`NAXIS1 (row length) = ${naxis1}, NAXIS2 (row count) = ${naxis2}, TFIELDS (field count) = ${tfields}`);
        
        if (!naxis1 || !naxis2 || !tfields) {
            console.error('Binary table missing required header information');
            const errorResult = new Float32Array(0) as TableResult;
            Object.defineProperties(errorResult, {
                columns: { value: new Map(), writable: true },
                getColumnValue: { value: () => '', writable: true },
                isStringColumn: { value: () => false, writable: true }
            });
            return errorResult;
        }

        // Parse column information
        const columns = new Map<string, ColumnInfo>();

        let currentOffset = 0;
        
        // First collect all column information
        for (let i = 1; i <= tfields; i++) {
            const tform = header.getItem(`TFORM${i}`)?.value;
            const ttype = header.getItem(`TTYPE${i}`)?.value || `COL${i}`;
            const tunit = header.getItem(`TUNIT${i}`)?.value || '';
            
            if (!tform) {
                console.error(`Missing TFORM${i} definition`);
                continue;
            }
            
            // Parse TFORM format: rTa
            const match = tform.match(/^(\d*)([A-Z])/);
            if (!match) {
                console.error(`Invalid TFORM${i} format: ${tform}`);
                continue;
            }
            
            const repeatCount = match[1] ? parseInt(match[1]) : 1;
            const dataType = match[2];
            
            // Determine data type byte size and corresponding TypedArray
            let byteSize: number;
            let ArrayType: any;
            let isString = false;
            
            switch (dataType) {
                case 'L':  // Logical
                    byteSize = 1;
                    ArrayType = null;  // Don't use TypedArray
                    isString = false;
                    break;
                case 'X':  // Bit
                    byteSize = 1;
                    ArrayType = Int8Array;
                    break;
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
                case 'K':  // 64-bit integer
                    byteSize = 8;
                    ArrayType = Float64Array; // Use Float64Array as JavaScript has no Int64Array
                    break;
                case 'A':  // Character
                    byteSize = 1;
                    isString = true;
                    break;
                case 'E':  // Single-precision floating point
                    byteSize = 4;
                    ArrayType = Float32Array;
                    break;
                case 'D':  // Double-precision floating point
                    byteSize = 8;
                    ArrayType = Float64Array;
                    break;
                case 'C':  // Single-precision complex
                    byteSize = 8;
                    ArrayType = Float32Array; // Use Float32Array, each complex number uses two elements
                    break;
                case 'M':  // Double-precision complex
                    byteSize = 16;
                    ArrayType = Float64Array; // Use Float64Array, each complex number uses two elements
                    break;
                case 'P':  // Array Descriptor (32-bit)
                    byteSize = 8;
                    ArrayType = Int32Array; // Use Int32Array to store descriptor
                    break;
                case 'Q':  // Array Descriptor (64-bit)
                    byteSize = 16;
                    ArrayType = Float64Array; // Use Float64Array to store descriptor
                    break;
                default:
                    console.warn(`Unsupported data type: ${dataType}`);
                    continue;
            }

            // Create appropriate size array for each column / 为每列创建适当大小的数组
            const arraySize = naxis2 * repeatCount;
            const columnData = dataType === 'L' ? new Array(arraySize).fill(false) :
                              isString ? new Array(naxis2) :
                              new ArrayType(arraySize);

            columns.set(ttype, {
                name: ttype,
                format: tform,
                unit: tunit,
                dataType,
                repeatCount,
                byteOffset: currentOffset,
                byteSize,
                data: columnData,
                isString: isString
            });

            currentOffset += byteSize * repeatCount;
        }

        try {
            // Read data for each row / 读取每一行的数据
            for (let row = 0; row < naxis2; row++) {
                const rowStart = offset + row * naxis1;

                // Process each column / 处理每一列
                for (const [name, column] of columns) {
                    const colOffset = rowStart + column.byteOffset;
                    this.buffer.seek(colOffset);

                    // Read all values for this column in current row / 读取该列在当前行的所有值
                    for (let r = 0; r < column.repeatCount; r++) {
                        const dataIndex = row * column.repeatCount + r;
                        
                        try {
                            let value: number;
                            switch (column.dataType) {
                                case 'L': // Logical / 逻辑值
                                    // Read raw byte value / 读取原始字节值
                                    const rawByte = this.buffer.readInt8();
                                    // According to FITS standard, 'T' and non-zero values are true, 'F' and zero values are false / 根据FITS标准，'T'和非零值表示true，'F'和零值表示false
                                    const boolValue = rawByte === 84 || (rawByte !== 0 && rawByte !== 70);  // 84 is ASCII for 'T', 70 is ASCII for 'F' / 84是'T'的ASCII码，70是'F'的ASCII码
                                    if (column.isString) {
                                        column.data[row] = boolValue ? 'True' : 'False';
                                    } else {
                                        column.data[dataIndex] = boolValue;
                                    }
                                    continue;  // Skip value assignment / 跳过value赋值
                                case 'X': // Bit / 位
                                    // For bit data type, special handling is needed / 对于位数据类型，需要特殊处理
                                    // In FITS, bit data is stored in bytes, each byte contains 8 bits / 在FITS中，位数据是按字节存储的，每个字节包含8个位
                                    // We need to calculate which byte contains the current bit and its position in the byte / 我们需要计算当前位在哪个字节，以及在字节中的位置
                                    const byteIndex = Math.floor(r / 8);
                                    const bitIndex = r % 8;
                                    
                                    // Read the byte containing this bit / 读取包含该位的字节
                                    const byteValue = this.buffer.readInt8();
                                    
                                    // Extract the specific bit value (starting from most significant bit) / 提取特定位的值 (从最高有效位开始)
                                    value = (byteValue & (1 << (7 - bitIndex))) ? 1 : 0;
                                    
                                    // If not the last bit, need to move back position for next read / 如果不是最后一位，需要回退位置以便下一次读取同一个字节
                                    if (bitIndex < 7 && r < column.repeatCount - 1) {
                                        this.buffer.seek(this.buffer.getPosition() - 1);
                                    }
                                    break;
                                case 'B': // Unsigned byte / 无符号字节
                                    value = this.buffer.readInt8();
                                    // Ensure unsigned interpretation / 确保无符号解释
                                    if (value < 0) value += 256;
                                    break;
                                case 'I': // 16-bit integer / 16位整数
                                    value = this.buffer.readInt16();
                                    break;
                                case 'J': // 32-bit integer / 32位整数
                                    value = this.buffer.readInt32();
                                    break;
                                case 'K': // 64-bit integer / 64位整数
                                    // Use readInt64 method to read 64-bit integer / 使用readInt64方法读取64位整数
                                    value = this.buffer.readInt64();
                                    break;
                                case 'A': // Character / 字符
                                    // Read complete string / 读取完整的字符串
                                    const rawStr = this.buffer.readString(column.repeatCount);
                                    // Only clean trailing control characters and invisible characters / 只清理末尾的控制字符和不可见字符
                                    const strValue = rawStr.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]+$/, '');
                                    // Store processed string directly / 直接存储处理后的字符串
                                    if (column.isString) {
                                        column.data[row] = strValue;
                                    }
                                    // Skip processed characters / 跳过已处理的字符
                                    r += column.repeatCount - 1;
                                    continue;  // Skip value assignment / 使用continue跳过value的赋值
                                case 'E': // Single-precision floating point / 单精度浮点数
                                    value = this.buffer.readFloat32();
                                    break;
                                case 'D': // Double-precision floating point / 双精度浮点数
                                    value = this.buffer.readFloat64();
                                    break;
                                case 'C': // Single-precision complex / 单精度复数
                                    // Read real and imaginary parts, but only store real part / 读取实部和虚部，但只存储实部
                                    const realC = this.buffer.readFloat32();
                                    const imagC = this.buffer.readFloat32();
                                    value = realC; // Only store real part / 只存储实部
                                    break;
                                case 'M': // Double-precision complex / 双精度复数
                                    // Read real and imaginary parts, but only store real part / 读取实部和虚部，但只存储实部
                                    const realM = this.buffer.readFloat64();
                                    const imagM = this.buffer.readFloat64();
                                    value = realM; // Only store real part / 只存储实部
                                    break;
                                case 'P': // Array Descriptor (32-bit) / 数组描述符(32位)
                                    // Read two 32-bit integers, but only store the first one / 读取两个32位整数，但只存储第一个
                                    const p1 = this.buffer.readInt32();
                                    const p2 = this.buffer.readInt32();
                                    value = p1;
                                    break;
                                case 'Q': // Array Descriptor (64-bit) / 数组描述符(64位)
                                    // Read two 64-bit integers, but only store the first one / 读取两个64位整数，但只存储第一个
                                    const q1 = this.buffer.readFloat64();
                                    const q2 = this.buffer.readFloat64();
                                    value = q1;
                                    break;
                                default:
                                    value = 0;
                            }
                            
                            if (dataIndex < column.data.length) {
                                column.data[dataIndex] = value;
                            }
                        } catch (error) {
                            console.error(`Error reading data: column=${name}, row=${row}, repeat=${r}`, error);
                            throw error;
                        }
                    }
                }

                // Output progress / 输出进度
                if (row % 1000 === 0 || row === naxis2 - 1) {
                    // console.log(`Progress: ${((row + 1) / naxis2 * 100).toFixed(1)}%`);
                }
            }

            // Output sample data for each column / 输出每列的示例数据
            for (const [name, column] of columns) {
                if (column.isString) {
                    // For string type, output string values / 对于字符串类型，输出字符串值
                    // console.log(`First 10 data for column ${name}:`, column.data.slice(0, 10));
                } else if (column.dataType === 'L') {
                    // For boolean type, handle array case specially / 对于布尔类型，需要特殊处理数组情况
                    const sampleData = column.repeatCount === naxis2 ?
                        column.data.slice(0, 10) :
                        Array.from({ length: Math.min(10, naxis2) }, (_, i) => 
                            column.data.slice(i * column.repeatCount, (i + 1) * column.repeatCount));
                    // console.log(`First 10 data for column ${name}:`, sampleData);
                } else {
                    // For numeric type, handle array case specially / 对于数值类型，需要特殊处理数组情况
                    const sampleData = column.repeatCount === naxis2 ?
                        Array.from(column.data.slice(0, 10)) :
                        Array.from({ length: Math.min(10, naxis2) }, (_, i) => 
                            Array.from(column.data.slice(i * column.repeatCount, (i + 1) * column.repeatCount)));
                    // console.log(`First 10 data for column ${name}:`, sampleData);
                }
            }

            // Create a Map containing all column data / 创建包含所有列数据的Map
            const columnsData = new Map<string, ColumnData>();
            for (const [name, column] of columns) {
                if (column.dataType === 'L') {
                    // For boolean type, create BooleanColumnData / 对于布尔类型，创建BooleanColumnData
                    const booleanColumn: BooleanColumnData = {
                        name: column.name,
                        data: column.repeatCount === naxis2 ? 
                            column.data as boolean[] :
                            Array.from({ length: naxis2 }, (_, i) => 
                                (column.data as boolean[]).slice(i * column.repeatCount, (i + 1) * column.repeatCount)),
                        format: column.format,
                        unit: column.unit,
                        dataType: column.dataType,
                        repeatCount: column.repeatCount,
                        getValue(index: number): boolean {
                            if (Array.isArray(this.data[index])) {
                                return (this.data[index] as boolean[])[0];
                            }
                            return this.data[index] as boolean;
                        }
                    };
                    columnsData.set(name, booleanColumn);
                } else if (column.isString) {
                    // For string type, create StringColumnData / 对于字符串类型，创建StringColumnData
                    const stringColumn: StringColumnData = {
                        name: column.name,
                        data: column.data as string[],  // String type has already handled repeatCount / 字符串类型已经正确处理了repeatCount
                        format: column.format,
                        unit: column.unit,
                        dataType: column.dataType,
                        repeatCount: column.repeatCount,
                        getValue(index: number): string {
                            return this.data[index] || '';
                        }
                    };
                    columnsData.set(name, stringColumn);
                } else {
                    // For numeric type, create NumericColumnData / 对于数值类型，创建NumericColumnData
                    const numericColumn: NumericColumnData = {
                        name: column.name,
                        data: column.repeatCount === naxis2 ?
                            column.data as Float32Array :
                            new Float32Array(column.data as Float32Array),  // Keep original data structure / 保持原始数据结构
                        format: column.format,
                        unit: column.unit,
                        dataType: column.dataType,
                        repeatCount: column.repeatCount,
                        getValue(index: number): number | number[] {
                            if (this.repeatCount === naxis2) {
                                return this.data[index];
                            } else {
                                // Return all data for this row / 返回该行的所有数据
                                return Array.from(this.data.slice(
                                    index * this.repeatCount, 
                                    (index + 1) * this.repeatCount
                                ));
                            }
                        }
                    };
                    columnsData.set(name, numericColumn);
                }
            }

            // For backward compatibility, we still return first column data as main data / 为了保持向后兼容，我们仍然返回第一列数据作为主数据
            const firstColumn = Array.from(columns.values())[0];
            if (!firstColumn) {
                const emptyResult = new Float32Array(0) as TableResult;
                Object.defineProperties(emptyResult, {
                    columns: { value: new Map(), writable: true },
                    getColumnValue: { value: () => '', writable: true },
                    isStringColumn: { value: () => false, writable: true }
                });
                return emptyResult;
            }

            // Create base array with correct length / 创建基础数组，确保长度正确
            const baseArray = firstColumn.repeatCount === naxis2 ?
                new Float32Array(firstColumn.data) :
                new Float32Array(naxis2);
            const result = baseArray as TableResult;
            
            // Add additional properties / 添加额外的属性
            Object.defineProperties(result, {
                columns: { value: columnsData, writable: true },
                getColumnValue: {
                    value: function(columnName: string, index: number): string | number | number[] {
                        const column = this.columns.get(columnName);
                        if (!column) return '';
                        return column.getValue(index);
                    },
                    writable: true
                },
                isStringColumn: {
                    value: function(columnName: string): boolean {
                        const column = this.columns.get(columnName);
                        return column?.dataType === 'A';
                    },
                    writable: true
                }
            });

            return result;

        } catch (error) {
            console.error('Error parsing binary table data:', error);
            if (error instanceof Error) {
                console.error('Error details:', error.message);
                console.error('Stack trace:', error.stack);
            }
            const errorResult = new Float32Array(0) as TableResult;
            Object.defineProperties(errorResult, {
                columns: { value: new Map(), writable: true },
                getColumnValue: { value: () => '', writable: true },
                isStringColumn: { value: () => false, writable: true }
            });
            return errorResult;
        }
    }

    private parseAsciiTable(offset: number, header: FITSHeader, availableBytes: number): TableResult {
        if (!this.buffer) throw new Error('Buffer not initialized');
        
        // console.log('Start parsing ASCII table data');
        // console.log('Data start offset:', offset);
        // console.log('Available bytes:', availableBytes);
        
        const naxis1 = header.getItem('NAXIS1')?.value;
        const naxis2 = header.getItem('NAXIS2')?.value;
        const tfields = header.getItem('TFIELDS')?.value;
        
        // console.log(`NAXIS1 (row length) = ${naxis1}, NAXIS2 (rows) = ${naxis2}, TFIELDS (fields) = ${tfields}`);
        
        if (!naxis1 || !naxis2 || !tfields) {
            console.error('Missing required header information for ASCII table');
            const errorResult = new Float32Array(0) as TableResult;
            Object.defineProperties(errorResult, {
                columns: { value: new Map(), writable: true },
                getColumnValue: { value: () => '', writable: true },
                isStringColumn: { value: () => false, writable: true }
            });
            return errorResult;
        }

        // Parse column information / 解析列信息
        const columns = new Map<string, ColumnInfo>();
        
        // First collect all column information / 首先收集所有列的信息
        for (let i = 1; i <= tfields; i++) {
            const tform = header.getItem(`TFORM${i}`)?.value;
            const ttype = header.getItem(`TTYPE${i}`)?.value || `COL${i}`;
            const tunit = header.getItem(`TUNIT${i}`)?.value || '';
            const tbcol = header.getItem(`TBCOL${i}`)?.value;
            
            if (!tform || !tbcol) {
                console.error(`Missing TFORM${i} or TBCOL${i} definition`);
                continue;
            }
            
            // Parse TFORM format / 解析TFORM格式
            const formatMatch = tform.trim().match(/^([A-Z])(\d+)(\.(\d+))?$/);
            if (!formatMatch) {
                console.error(`Invalid TFORM${i} format: ${tform}`);
                continue;
            }
            
            const dataType = formatMatch[1];
            const width = parseInt(formatMatch[2]);
            const precision = formatMatch[4] ? parseInt(formatMatch[4]) : 0;
            
            // Determine data type and corresponding array type / 确定数据类型和对应的数组类型
            let ArrayType: any;
            let isString = false;
            
            switch (dataType) {
                case 'I':  // Integer / 整数
                    ArrayType = Int32Array;
                    break;
                case 'F':  // Fixed-point / 定点数
                case 'E':  // Exponential floating-point / 指数浮点数
                    ArrayType = Float32Array;
                    break;
                case 'D':  // Double-precision floating-point / 双精度浮点数
                    ArrayType = Float64Array;
                    break;
                case 'A':  // Character / 字符
                    isString = true;
                    break;
                default:
                    console.warn(`Unsupported data type: ${dataType}`);
                    continue;
            }

            // Create column data array / 创建列数据数组
            const columnData = isString ? new Array(naxis2) : new ArrayType(naxis2);

            columns.set(ttype, {
                name: ttype,
                format: tform,
                unit: tunit,
                dataType,
                repeatCount: 1,  // ASCII table has only one value per field / ASCII表格每个字段只有一个值
                byteOffset: tbcol - 1,  // FITS TBCOL is 1-based / FITS的TBCOL是1-based
                byteSize: width,
                data: columnData,
                isString
            });
        }

        try {
            // Read data for each row / 读取每一行的数据
            const rowBuffer = new Uint8Array(naxis1);
            for (let row = 0; row < naxis2; row++) {
                // Read entire row data / 读取整行数据
                const rowStart = offset + row * naxis1;
                this.buffer.seek(rowStart);
                
                for (let i = 0; i < naxis1; i++) {
                    rowBuffer[i] = this.buffer.readInt8();
                }
                
                // Process each column / 处理每一列
                for (const [name, column] of columns) {
                    const fieldStart = column.byteOffset;
                    const fieldEnd = fieldStart + column.byteSize;
                    
                    // Extract field text / 提取字段文本
                    const fieldText = new TextDecoder().decode(rowBuffer.slice(fieldStart, fieldEnd)).trim();
                    
                    try {
                        if (column.isString) {
                            // Store string type directly / 字符串类型直接存储
                            column.data[row] = fieldText;
                        } else {
                            // Parse numeric types / 数值类型需要解析
                            const value = column.dataType === 'I' ? 
                                parseInt(fieldText) : 
                                parseFloat(fieldText);
                            
                            if (!isNaN(value)) {
                                column.data[row] = value;
                            } else {
                                console.warn(`Cannot parse value: ${fieldText} (column=${name}, row=${row})`);
                                column.data[row] = 0;
                            }
                        }
                    } catch (error) {
                        console.error(`Error parsing data: column=${name}, row=${row}, text=${fieldText}`, error);
                        column.data[row] = column.isString ? '' : 0;
                    }
                }

                // Output progress / 输出进度
                // if (row % 1000 === 0 || row === naxis2 - 1) {
                    // console.log(`Progress: ${((row + 1) / naxis2 * 100).toFixed(1)}%`);
                // }
            }

            // Create column data Map / 创建列数据Map
            const columnsData = new Map<string, ColumnData>();
            for (const [name, column] of columns) {
                if (column.isString) {
                    // For string type, create StringColumnData / 对于字符串类型，创建StringColumnData
                    const stringColumn: StringColumnData = {
                        name: column.name,
                        data: column.data as string[],
                        format: column.format,
                        unit: column.unit,
                        dataType: column.dataType,
                        repeatCount: 1,
                        getValue(index: number): string {
                            return this.data[index] || '';
                        }
                    };
                    columnsData.set(name, stringColumn);
                } else {
                    // For numeric type, create NumericColumnData / 对于数值类型，创建NumericColumnData
                    const numericColumn: NumericColumnData = {
                        name: column.name,
                        data: column.data as Float32Array,
                        format: column.format,
                        unit: column.unit,
                        dataType: column.dataType,
                        repeatCount: 1,
                        getValue(index: number): number {
                            return this.data[index];
                        }
                    };
                    columnsData.set(name, numericColumn);
                }
            }

            // Create result array / 创建结果数组
            const firstColumn = Array.from(columns.values())[0];
            if (!firstColumn) {
                const emptyResult = new Float32Array(0) as TableResult;
                Object.defineProperties(emptyResult, {
                    columns: { value: new Map(), writable: true },
                    getColumnValue: { value: () => '', writable: true },
                    isStringColumn: { value: () => false, writable: true }
                });
                return emptyResult;
            }

            const result = new Float32Array(firstColumn.data) as TableResult;
            
            // Add additional properties / 添加额外的属性
            Object.defineProperties(result, {
                columns: { value: columnsData, writable: true },
                getColumnValue: {
                    value: function(columnName: string, index: number): string | number {
                        const column = this.columns.get(columnName);
                        if (!column) return '';
                        return column.getValue(index);
                    },
                    writable: true
                },
                isStringColumn: {
                    value: function(columnName: string): boolean {
                        const column = this.columns.get(columnName);
                        return column?.dataType === 'A';
                    },
                    writable: true
                }
            });

            return result;

        } catch (error) {
            console.error('Error parsing ASCII table:', error);
            throw error;
        }
    }
} 
