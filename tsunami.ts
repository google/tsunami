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
  mode: number;
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
const CACHE_SIZE = 512 * 1024;
const LONG_LINK_FILENAME = '././@LongLink';

function isValidName(fileName: string) {
  return (fileName !== '' && fileName !== '.' && fileName !== './');
}

/** Function that untars files from a stream. */
export function untarBuffer(arrayBuffer: ArrayBuffer, tarfile: TarFile) {
  const tarFileStream = new UntarFileStream(arrayBuffer, tarfile);
  return tarFileStream.readNextFile();
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
    stream: UntarStream, validFileTypes: RegExp[], activeLongLink: string|null,
    globalPaxHeader: PaxHeader|null, paxHeader: PaxHeader|null) {
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
  let continueRead = name === LONG_LINK_FILENAME || name.includes('PaxHeader');
  continueRead ||= globalPaxHeader !== null || paxHeader !== null;
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
  static parse(buffer: ArrayBuffer) {
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
      const fieldLength =
          Number(new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0x20))));
      const fieldText = new TextDecoder().decode(bytes.subarray(0, fieldLength));
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
          // google-local-mod: cast to any for TypeScript 4.0 compatability.
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
  constructor(arrayBuffer: ArrayBuffer, public position: number = 0) {
    this.bufferView = new DataView(arrayBuffer);
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
  file: TarFile;
  constructor(arrayBuffer: ArrayBuffer, tarfile: TarFile) {
    this.stream = new UntarStream(arrayBuffer);
    this.file = tarfile;
  }

  readNextFile(): UncompressedFile {
    const stream = this.stream;

    const dataBeginPos = stream.position;
    // Assert that this is a ustar tar file.
    if (!(this.file.ustarFormat.indexOf('ustar') > -1)) {
      throw new Error('file is not in ustar format');
    }
    // Then we can safely read the contents of the file.
    this.file.buffer = stream.readBuffer(stream.size());

    if (this.file.prefix) {
      this.file.name = this.file.prefix + '/' + this.file.name;
    }

    let dataEndPos = dataBeginPos + this.file.size;

    // File data is padded to reach a 512 byte boundary; skip the padded
    // bytes too.
    if (this.file.size % 512 !== 0) {
      dataEndPos += 512 - (this.file.size % 512);
    }

    stream.setPosition(dataEndPos);

    return {
      name: this.file.name,
      mode: parseInt(this.file.mode, 8),
      buffer: this.file.buffer || new ArrayBuffer(0)
    };
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

  constructor(
      readonly validFileTypes: RegExp[],
      readonly excludeInvalidFiles: boolean = false,
      readonly cacheSize = CACHE_SIZE) {
    this.files = [];
  }

  private async readFileAsArrayBuffer(inputBlob: Blob) {
    return await new Response(inputBlob).arrayBuffer();
  }

  async untar(file: File) {
    let fileOffset = 0;
    let activeLongLink = null;
    let paxHeader = null;
    let globalPaxHeader = null;
    let header: TarFile|null = null;
    let buffer = new ArrayBuffer(0);
    while (fileOffset < file.size) {
      let cacheOffset = 0;
      const unusedCache = buffer.byteLength;
      let slice;
      // Read cache size amount at a time, plus the unused section of the
      // previous cache
      if (file.size - fileOffset >= this.cacheSize) {
        slice =
            file.slice(fileOffset - unusedCache, fileOffset + this.cacheSize);
      } else {
        slice = file.slice(fileOffset - unusedCache, file.size);
      }
      fileOffset += slice.size - unusedCache;
      buffer = await this.readFileAsArrayBuffer(slice);

      while (buffer.byteLength - cacheOffset >= HEADER_SIZE) {
        if (!header) {
          const stream = new UntarStream(buffer, cacheOffset);
          header = makeTarFile(
              stream, this.validFileTypes, activeLongLink, globalPaxHeader,
              paxHeader);
          // A LongLink only applies to the file immediately following it, so we
          // clear it after use
          activeLongLink = null;

          // Apply pax headers if we have them
          if (globalPaxHeader) {
            globalPaxHeader.applyHeader(header);
          }
          if (paxHeader) {
            paxHeader.applyHeader(header);
            paxHeader = null;
          }
          cacheOffset += HEADER_SIZE;
        }
        // if we don't have a header after trying to read one we're in the 0-padding at the end of the tar
        if(!header) {
          return;
        }

        // Special case: skipping file contents. We do this early so we can quickly jump to the next file header
        const isRegularFile = ['', '0', '5'].includes(header.type);
        const hasValidName = isValidName(header.name);
        const isValidType = this.validFileTypes.some(type => type.test(header!.name));
        if(isRegularFile && hasValidName) {
          if(!isValidType) {
            if (!this.excludeInvalidFiles) {
              const newFile: UncompressedFile = {
                name: header.name,
                mode: parseInt(header.mode, 8),
                buffer: new ArrayBuffer(0)
              };
              this.files.push(newFile);
            }

            if (header.size > 0 && !isNaN(header.size)) {
              cacheOffset += header.paddedSize;
            }
            header = null;
            continue;
          }
        }
        // Make sure we don't jump past the end of the cache after
        // reading/skipping file contents
        if (buffer.byteLength - cacheOffset < header.paddedSize) {
          break;
        }
        if (hasValidName) {
          const contentBuffer = buffer.slice(cacheOffset, cacheOffset + header.size);
          switch (header.type) {
            case 'g': // global pax header
              globalPaxHeader = PaxHeader.parse(contentBuffer);
              break;
            case 'x': // pax header
              paxHeader = PaxHeader.parse(contentBuffer);
              break;
            case 'L': // linux long link header
              const file = untarBuffer(contentBuffer, header);
              // LongLink has a terminator at the end we need to exclude.
              activeLongLink = new TextDecoder().decode(file.buffer.slice(0, -1));
              break;
            default:
              const headerName = header.name;
              if (isValidType) {
                this.files.push(untarBuffer(contentBuffer, header));
              }
          }
        }
        if (header.size > 0 && !isNaN(header.size)) {
          cacheOffset += header.paddedSize;
        }
        header = null;
      }
      // If we passed the end of the cache by skipping a file, advance the fileOffset to compensate
      if(cacheOffset > buffer.byteLength) {
        fileOffset += (cacheOffset - buffer.byteLength);
      }
      buffer = buffer.slice(cacheOffset, buffer.byteLength);
    }
  }
}
