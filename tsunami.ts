/**
 * @license
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2015 Sebastian Jørgensen
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */

/** Uncompressed file extracted from .tar */
export interface UncompressedFile {
  name: string;
  buffer: ArrayBuffer;
}

const NAME_LENGTH = 100;
const MODE_LENGTH = 8;
const UID_LENGTH = 8;
const GID_LENGTH = 8;
const SIZE_LENGTH = 12;
const MTIME_LENGTH = 12;
const CHECKSUM_LENGTH = 8;
const TYPE_LENGTH = 1;
const LINKNAME_LENGTH = 100;
const USTARFORMAT_LENGTH = 6;
const VERSION_LENGTH = 2;
const UNAME_LENGTH = 32;
const GNAME_LENGTH = 32;
const DEVMAJOR_LENGTH = 8;
const DEVMINOR_LENGTH = 8;
const NAMEPREFIX_LENGTH = 155;
const HEADER_SIZE = 512;
const CACHE_SIZE = 500000000;
const LONG_LINK_FILENAME = '././@LongLink';
const LONG_LINK_HEADER = 'L';

function isValidName(fileName: string) {
  return (fileName !== '' && fileName !== '.');
}

/** Function that untars files from a stream. */
export function untarBuffer(arrayBuffer: ArrayBuffer, tarfile: TarFile) {
  const tarFileStream = new UntarFileStream(arrayBuffer, tarfile);
  const files: UncompressedFile[] = [];
  while (tarFileStream.hasNext()) {
    files.push(tarFileStream.next());
  }
  return files;
}

/** Function that converts an octal value in a string to a decimal. */
function decodeOctal(value: string) {
  if (!isNaN(Number(value))) {
    // Needed to parse octal.
    // tslint:disable-next-line:ban
    return parseInt(value, 8);
  } else {
    return 0;
  }
}

/** Function that creates a TarFile object from a stream. */
function makeTarFile(
    stream: UntarStream, validFileTypes: RegExp[],
    activeLongLink: string|null) {
  let name = stream.readString(NAME_LENGTH);
  const mode = stream.readString(MODE_LENGTH);
  const uid = decodeOctal(stream.readString(UID_LENGTH));
  const gid = decodeOctal(stream.readString(GID_LENGTH));
  const size = decodeOctal(stream.readString(SIZE_LENGTH));
  // The file will be padded with null bytes to fill a HEADER_SIZE block
  const paddedSize = Math.ceil(size / HEADER_SIZE) * HEADER_SIZE;
  // If the previous file was a "long link" then it holds the file name for
  // this file. Apply the full name before checking if we need a full read.
  name = activeLongLink || name;
  // Determines whether the rest of the tar header should be read. If it's the
  // special "long link" we need to read the whole file since the contents are
  // the file name of the next file.
  let continueRead = name === LONG_LINK_FILENAME;
  continueRead ||= validFileTypes.some(type => type.test(name));

  let mtime = 0;
  let checksum = 0;
  let type = '';
  let linkname = '';
  let ustarFormat = '';
  let version = '';
  let uname = '';
  let gname = '';
  let devmajor = 0;
  let devminor = 0;
  let prefix = '';
  if (continueRead) {
    mtime = decodeOctal(stream.readString(MTIME_LENGTH));
    checksum = decodeOctal(stream.readString(CHECKSUM_LENGTH));
    type = stream.readString(TYPE_LENGTH);
    linkname = stream.readString(LINKNAME_LENGTH);
    ustarFormat = stream.readString(USTARFORMAT_LENGTH);
    version = stream.readString(VERSION_LENGTH);
    uname = stream.readString(UNAME_LENGTH);
    gname = stream.readString(GNAME_LENGTH);
    devmajor = decodeOctal(stream.readString(DEVMAJOR_LENGTH));
    devminor = decodeOctal(stream.readString(DEVMINOR_LENGTH));
    prefix = stream.readString(NAMEPREFIX_LENGTH);
  }
  const tarfile: TarFile = {
    prefix,
    name,
    mode,
    uid,
    gid,
    size,
    paddedSize,
    mtime,
    checksum,
    type,
    linkname,
    ustarFormat,
    version,
    uname,
    gname,
    devmajor,
    devminor,
  };
  return tarfile;
}

/** Class that parses headers in pax format. */
export class PaxHeader {
  constructor(public fields: Array<{name: string; value: string | number;}>) {}
  parse(buffer: ArrayBuffer) {
    // https://www.ibm.com/support/knowledgecenter/en/SSLTBW_2.3.0/com.ibm.zos.v2r3.bpxa500/paxex.htm
    // An extended header shall consist of one or more records, each
    // constructed as follows:
    // "%d %s=%s\n", <length>, <keyword>, <value>

    // The extended header records shall be encoded according to the
    // ISO/IEC10646-1:2000 standard (UTF-8). The <length> field, <blank>,
    // equals sign, and <newline> shown shall be limited to the portable
    // character set, as encoded in UTF-8. The <keyword> and <value> fields
    // can be any UTF-8 characters. The <length> field shall be the decimal
    // length of the extended header record in octets, including the trailing
    // <newline>.

    let bytes = new Uint8Array(buffer);
    const fields = [];

    while (bytes.length > 0) {
      // Decode bytes up to the first space character; that is the total field
      // length
      const decoder = new TextDecoder();
      const fieldLength =
          Number(decoder.decode(bytes.subarray(0, bytes.indexOf(0x20))));
      const fieldText = decoder.decode(bytes.subarray(0, fieldLength));
      const fieldMatch = fieldText.match(/^\d+ ([^=]+)=(.*)\n$/);

      if (fieldMatch === null) {
        throw new Error('Invalid PAX header data format.');
      }

      const fieldName = fieldMatch[1];
      const fieldValue = fieldMatch[2];
      let fieldNum = 0;
      if (fieldValue.length === 0) {
        fieldNum = 0;
      } else if (fieldValue.match(/^\d+$/) !== null) {
        // If it's an integer field, parse it as int
        fieldNum = Number(fieldValue);
      }
      let field = null;
      if (fieldNum !== 0) {
        field = {name: fieldName, value: fieldNum};
      } else {
        field = {name: fieldName, value: fieldValue};
      }
      fields.push(field);

      bytes = bytes.subarray(fieldLength);  // Cut off the parsed field data
    }

    return new PaxHeader(fields);
  }
  applyHeader(file: TarFile) {
    // Apply fields to the file
    // If a field is of value null, it should be deleted from the file
    // https://www.mkssoftware.com/docs/man4/pax.4.asp

    for (const field of this.fields) {
      let fieldName = field.name;
      const fieldValue: string|number = field.value;

      if (fieldName === 'path') {
        // This overrides the name and prefix fields in the following header
        // block.
        fieldName = 'name';

        if (file.prefix !== undefined) {
          delete (file as any).prefix;
        }
      } else if (fieldName === 'linkpath') {
        // This overrides the linkname field in the following header block.
        fieldName = 'linkname';
      }
      if (fieldValue === null) {
        delete file[fieldName as keyof TarFile];
      } else if (typeof file[fieldName as keyof TarFile] === 'string') {
        (file[fieldName as keyof TarFile] as string) = fieldValue as string;
      } else if (typeof file[fieldName as keyof TarFile] === 'number') {
        (file[fieldName as keyof TarFile] as number) = fieldValue as number;
      }
    }
  }
}

/** Class that reads from file to be untarred. */
export class UntarStream {
  bufferView: DataView;
  position: number;
  constructor(arrayBuffer: ArrayBuffer) {
    this.bufferView = new DataView(arrayBuffer);
    this.position = 0;
  }
  readString(charCount: number) {
    const charSize = 1;
    const byteCount = charCount * charSize;

    const charCodes = [];

    for (let i = 0; i < charCount; ++i) {
      const charCode = this.bufferView.getUint8(this.position + (i * charSize));
      if (charCode !== 0) {
        charCodes.push(charCode);
      } else {
        break;
      }
    }

    this.seek(byteCount);

    return String.fromCharCode.apply(null, charCodes);
  }
  readBuffer(byteCount: number) {
    let buf = new ArrayBuffer(byteCount);
    buf =
        this.bufferView.buffer.slice(this.position, this.position + byteCount);
    this.seek(byteCount);
    return buf;
  }
  seek(byteCount: number) {
    this.position += byteCount;
  }

  peekUint32() {
    return this.bufferView.getUint32(this.position, true);
  }

  setPosition(newpos: number) {
    this.position = newpos;
  }

  size() {
    return this.bufferView.byteLength;
  }
}

/** Class that extracts files from UntarStream. */
export class UntarFileStream {
  stream: UntarStream;
  globalPaxHeader: PaxHeader;
  file: TarFile;
  private uncompressedFile: UncompressedFile;
  constructor(arrayBuffer: ArrayBuffer, tarfile: TarFile) {
    this.stream = new UntarStream(arrayBuffer);
    this.globalPaxHeader = new PaxHeader([{name: '', value: ''}]);
    this.file = tarfile;
    this.uncompressedFile = {name: this.file.name, buffer: new ArrayBuffer(0)};
  }

  setUncompressedFile(file: {name: string, buffer: ArrayBuffer}) {
    this.uncompressedFile = file;
  }

  getUncompressedFile() {
    return this.uncompressedFile;
  }
  hasNext() {
    // A tar file ends with 4 zero bytes
    const paxChecker: RegExp = /PaxHeader/;
    return this.stream.position + 4 < this.stream.size() &&
        !(paxChecker.test(this.file.name));
  }
  next() {
    return this.readNextFile();
  }
  readNextFile() {
    const stream = this.stream;
    let isHeaderFile = false;
    let paxHeader = null;

    const dataBeginPos = stream.position;
    // Assert that this is a ustar tar file.
    if (!(this.file.ustarFormat.indexOf('ustar') > -1)) {
      throw new Error('file is not in ustar format');
    }
    // Then we can safely read the contents of the file.
    this.file.buffer = stream.readBuffer(stream.size());

    if (this.file.prefix.length > 0) {
      this.file.name = this.file.prefix + '/' + this.file.name;
    }

    stream.setPosition(dataBeginPos);

    // Derived from https://www.mkssoftware.com/docs/man4/pax.4.asp
    // and
    // https://www.ibm.com/support/knowledgecenter/en/SSLTBW_2.3.0/com.ibm.zos.v2r3.bpxa500/pxarchfm.htm
    switch (this.file.type) {
      case '0':  // Normal file is either "0" or "\0".
      case '':   // In case of "\0", readString returns an empty string, that
                 // is "".
        this.file.buffer = stream.readBuffer(this.file.size);
        break;
      case '1':  // Link to another file already archived
        break;
      case '2':  // Symbolic link
        break;
      case '3':  // Character special device
        break;
      case '4':  // Block special device
        break;
      case '5':  // Directory
        break;
      case '6':  // FIFO special file
        break;
      case '7':  // Reserved
        break;
      case 'g':  // Global PAX header
        isHeaderFile = true;
        this.globalPaxHeader =
            this.globalPaxHeader.parse(stream.readBuffer(this.file.size));
        break;
      case 'x':  // PAX header
        isHeaderFile = true;
        paxHeader =
            this.globalPaxHeader.parse(stream.readBuffer(this.file.size));
        break;
      default:  // Unknown file type
        break;
    }

    if (this.file.buffer === undefined) {
      this.file.buffer = new ArrayBuffer(0);
    }

    let dataEndPos = dataBeginPos + this.file.size;

    // File data is padded to reach a 512 byte boundary; skip the padded
    // bytes too.
    if (this.file.size % 512 !== 0) {
      dataEndPos += 512 - (this.file.size % 512);
    }

    stream.setPosition(dataEndPos);

    if (isHeaderFile) {
      this.readNextFile();
    }

    if (this.globalPaxHeader !== null) {
      this.globalPaxHeader.applyHeader(this.file);
    }

    if (paxHeader !== null) {
      paxHeader.applyHeader(this.file);
    }
    if (this.file.buffer instanceof ArrayBuffer) {
      this.setUncompressedFile(
          {name: this.file.name, buffer: this.file.buffer});
    }
    return this.getUncompressedFile();
  }
}

/** Class that defines a tarred file object. */
export interface TarFile {
  name: string;
  mode: string;
  uid: number;
  gid: number;
  size: number;
  paddedSize: number;
  mtime: number;
  checksum: number;
  type: string;
  linkname: string;
  ustarFormat: string;
  version: string;
  uname: string;
  gname: string;
  devmajor: number;
  devminor: number;
  prefix: string;
  buffer?: ArrayBuffer;
}

/** Class for calling FileReader, slicing the file, and untarring. */
export class Tsunami {
  files: UncompressedFile[];
  fileNames: string[];
  cache: Blob;
  slice: Blob;
  buffer: ArrayBuffer;
  header: TarFile;

  constructor(
      readonly validFileTypes: RegExp[],
      readonly excludeInvalidFiles: boolean = false,
      readonly cacheSize = CACHE_SIZE) {
    this.files = [];
    this.fileNames = [];
    this.cache = new Blob([]);
    this.slice = new Blob([]);
    this.buffer = new ArrayBuffer(0);
    this.header = {
      prefix: '',
      name: '',
      mode: '',
      uid: 0,
      gid: 0,
      size: 0,
      paddedSize: 0,
      mtime: 0,
      checksum: 0,
      type: '',
      linkname: '',
      ustarFormat: '',
      version: '',
      uname: '',
      gname: '',
      devmajor: 0,
      devminor: 0,
    };
  }

  private readFileAsArrayBuffer(inputBlob: Blob) {
    const fileReader = new FileReader();
    return new Promise<ArrayBuffer>((resolve, reject) => {
      fileReader.onerror = () => {
        fileReader.abort();
        reject();
      };

      fileReader.onload = () => {
        let buffer = new ArrayBuffer(0);
        if (fileReader.result instanceof ArrayBuffer) {
          buffer = fileReader.result;
        }
        resolve(buffer);
      };

      fileReader.readAsArrayBuffer(inputBlob);
    });
  }

  private readFileContents(inputBuffer: ArrayBuffer, tarfile: TarFile) {
    const newFiles = untarBuffer(inputBuffer, tarfile);
    for (const newFile of newFiles) {
      this.files.push(newFile);
    }
  }

  async untar(file: File) {
    const fileSize = file.size;
    let fileOffset = 0;
    let needsHeader = true;
    let activeLongLink = null;
    while (fileOffset < file.size) {
      let cacheOffset = 0;
      // Read cache size amount at a time.
      if (file.size - fileOffset >= this.cacheSize) {
        this.slice = file.slice(fileOffset, fileOffset + this.cacheSize);
      } else {
        this.slice = file.slice(fileOffset, file.size);
      }
      fileOffset += this.slice.size;
      if (this.buffer.byteLength > 0) {
        const buffer = await this.readFileAsArrayBuffer(this.slice);
        const bufferLength: number = buffer.byteLength;
        const mergeArrays =
            new Uint8Array(this.buffer.byteLength + bufferLength);
        mergeArrays.set(new Uint8Array(this.buffer), 0);
        mergeArrays.set(new Uint8Array(buffer), this.buffer.byteLength);
        this.buffer = mergeArrays.buffer;
      } else {
        this.cache = this.slice;
        this.buffer = await this.readFileAsArrayBuffer(this.cache);
      }
      while (this.buffer.byteLength - cacheOffset >= HEADER_SIZE) {
        if (needsHeader) {
          const headerBuffer =
              this.buffer.slice(cacheOffset, cacheOffset + HEADER_SIZE);
          const stream = new UntarStream(headerBuffer);
          this.header =
              makeTarFile(stream, this.validFileTypes, activeLongLink);
          // A LongLink only applies to the file immediately following it, so we
          // clear it after use
          activeLongLink = null;
          cacheOffset += HEADER_SIZE;
        }
        needsHeader = true;
        // Make sure we don't jump past the end of the cache after
        // reading/skipping file contents
        if (this.buffer.byteLength - cacheOffset < this.header.paddedSize) {
          needsHeader = false;
          break;
        }
        if (this.header.type === LONG_LINK_HEADER) {
          const contentBuffer =
              this.buffer.slice(cacheOffset, cacheOffset + this.header.size);
          const files = untarBuffer(contentBuffer, this.header);
          // A LongLink will only contain 1 file, which is the file name of the
          // following file.
          const decoded = new TextDecoder('utf-8').decode(files[0].buffer);
          // LongLink has a terminator at the end we need to exclude.
          activeLongLink = decoded.slice(0, -1);
        } else if (this.excludeInvalidFiles && isValidName(this.header.name)) {
          // This flag tracks whether the name should be included.
          let includeName = !this.validFileTypes.length;
          for (const validFileType of this.validFileTypes) {
            if (!(validFileType.test(this.header.name))) {
              includeName = true;
            }
          }
          if (includeName) {
            this.fileNames.push(this.header.name);
          }
        } else if (!this.excludeInvalidFiles) {
          // Flag to measure whether a valid file type for processing was found.
          let noValidFile = true;
          for (const validFileType of this.validFileTypes) {
            if (validFileType.test(this.header.name)) {
              const contentBuffer = this.buffer.slice(
                  cacheOffset, cacheOffset + this.header.size);
              this.readFileContents(contentBuffer, this.header);
              noValidFile = false;
              break;
            }
          }
          if (noValidFile && isValidName(this.header.name)) {
            const newFile: UncompressedFile = {
              name: this.header.name,
              buffer: new ArrayBuffer(0)
            };
            this.files.push(newFile);
          }
        }
        if (this.header.size > 0 && !isNaN(this.header.size)) {
          cacheOffset += this.header.paddedSize;
        }
      }
      const buffer = this.buffer.slice(cacheOffset, this.buffer.byteLength);
      this.buffer = buffer;
    }
  }
}
