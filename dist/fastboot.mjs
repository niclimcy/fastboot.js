//#region src/errors.ts
/**
* Exception class for errors returned by the bootloader, as well as high-level
* fastboot errors resulting from bootloader responses.
*/
var FastbootError = class extends Error {
	status;
	bootloaderMessage;
	constructor(status, message) {
		super(`Bootloader replied with ${status}: ${message}`);
		this.status = status;
		this.bootloaderMessage = message;
		this.name = "FastbootError";
	}
};
/**
* Exception class for Sparse Image errors.
*/
var ImageError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ImageError";
	}
};
/**
* Exception class for logical partition parsing errors.
*/
var LpError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "LpError";
	}
};
/**
* Exception class for operations that exceeded their timeout duration.
*/
var TimeoutError = class extends Error {
	timeout;
	constructor(timeout) {
		super(`Timeout of ${timeout} ms exceeded`);
		this.name = "TimeoutError";
		this.timeout = timeout;
	}
};
/**
* Exception class for USB errors not directly thrown by WebUSB.
*/
var UsbError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "UsbError";
	}
};
let debugLevel = (/* @__PURE__ */ function(DebugLevel) {
	DebugLevel[DebugLevel["Silent"] = 0] = "Silent";
	DebugLevel[DebugLevel["Debug"] = 1] = "Debug";
	DebugLevel[DebugLevel["Verbose"] = 2] = "Verbose";
	return DebugLevel;
}({})).Silent;
let debugLogger = console.log;
function logDebug(...data) {
	if (debugLevel >= 1) debugLogger(...data);
}
function logVerbose(...data) {
	if (debugLevel >= 2) debugLogger(...data);
}
/**
* Change the debug level for the fastboot client:
*   - 0 = silent
*   - 1 = debug, recommended for general use
*   - 2 = verbose, for debugging only
*
* @param {number} level - Debug level to use.
*/
function setDebugLevel(level) {
	debugLevel = level;
}
/**
* Change the debug logger function for the fastboot client.
*
* @param {DebugLogger} logger - Debug logger function to use.
*/
function setDebugLogger(logger) {
	debugLogger = logger;
}
/**
* Reads all of the data in the given blob and returns it as an ArrayBuffer.
*
* @param {Blob} blob - Blob with the data to read.
* @returns {Promise<ArrayBuffer>} ArrayBuffer containing data from the blob.
* @ignore
*/
function readBlobAsBuffer(blob) {
	return new Promise((resolve, reject) => {
		let reader = new FileReader();
		reader.onload = () => {
			resolve(reader.result);
		};
		reader.onerror = () => {
			reject(reader.error);
		};
		reader.readAsArrayBuffer(blob);
	});
}
function waitForFrame() {
	return new Promise((resolve, _reject) => {
		window.requestAnimationFrame(resolve);
	});
}
async function runWithTimedProgress(onProgress, action, item, duration, workPromise) {
	let startTime = (/* @__PURE__ */ new Date()).getTime();
	let stop = false;
	onProgress(action, item, 0);
	let progressPromise = (async () => {
		let now;
		let targetTime = startTime + duration;
		do {
			now = (/* @__PURE__ */ new Date()).getTime();
			onProgress(action, item, (now - startTime) / duration);
			await waitForFrame();
		} while (!stop && now < targetTime);
	})();
	await Promise.race([progressPromise, workPromise]);
	stop = true;
	await progressPromise;
	await workPromise;
	onProgress(action, item, 1);
}
function runWithTimeout(promise, timeout) {
	return new Promise((resolve, reject) => {
		let timedOut = false;
		let tid = setTimeout(() => {
			timedOut = true;
			reject(new TimeoutError(timeout));
		}, timeout);
		promise.then((val) => {
			if (!timedOut) resolve(val);
		}).catch((err) => {
			if (!timedOut) reject(err);
		}).finally(() => {
			if (!timedOut) clearTimeout(tid);
		});
	});
}
//#endregion
//#region src/sparse.ts
const FILE_MAGIC = 3978755898;
const MAJOR_VERSION = 1;
const MINOR_VERSION = 0;
const CHUNK_HEADER_SIZE = 12;
const RAW_CHUNK_SIZE = 64 * 1024 * 1024;
let ChunkType = /* @__PURE__ */ function(ChunkType) {
	ChunkType[ChunkType["Raw"] = 51905] = "Raw";
	ChunkType[ChunkType["Fill"] = 51906] = "Fill";
	ChunkType[ChunkType["Skip"] = 51907] = "Skip";
	ChunkType[ChunkType["Crc32"] = 51908] = "Crc32";
	return ChunkType;
}({});
var BlobBuilder = class {
	blob;
	type;
	constructor(type = "") {
		this.type = type;
		this.blob = new Blob([], { type: this.type });
	}
	append(blob) {
		this.blob = new Blob([this.blob, blob], { type: this.type });
	}
	getBlob() {
		return this.blob;
	}
};
/**
* Returns a parsed version of the sparse image file header from the given buffer.
*
* @param {ArrayBuffer} buffer - Raw file header data.
* @returns {SparseHeader} Object containing the header information.
*/
function parseFileHeader(buffer) {
	let view = new DataView(buffer);
	if (view.getUint32(0, true) !== FILE_MAGIC) return null;
	let major = view.getUint16(4, true);
	let minor = view.getUint16(6, true);
	if (major !== MAJOR_VERSION || minor < MINOR_VERSION) throw new ImageError(`Unsupported sparse image version ${major}.${minor}`);
	let fileHdrSize = view.getUint16(8, true);
	let chunkHdrSize = view.getUint16(10, true);
	if (fileHdrSize !== 28 || chunkHdrSize !== CHUNK_HEADER_SIZE) throw new ImageError(`Invalid file header size ${fileHdrSize}, chunk header size ${chunkHdrSize}`);
	let blockSize = view.getUint32(12, true);
	if (blockSize % 4 !== 0) throw new ImageError(`Block size ${blockSize} is not a multiple of 4`);
	return {
		blockSize,
		blocks: view.getUint32(16, true),
		chunks: view.getUint32(20, true),
		crc32: view.getUint32(24, true)
	};
}
function parseChunkHeader(buffer) {
	let view = new DataView(buffer);
	return {
		type: view.getUint16(0, true),
		blocks: view.getUint32(4, true),
		dataBytes: view.getUint32(8, true) - CHUNK_HEADER_SIZE,
		data: null
	};
}
function calcChunksBlockSize(chunks) {
	return chunks.map((chunk) => chunk.blocks).reduce((total, c) => total + c, 0);
}
function calcChunksDataSize(chunks) {
	return chunks.map((chunk) => chunk.data.size).reduce((total, c) => total + c, 0);
}
function calcChunksSize(chunks) {
	return 28 + CHUNK_HEADER_SIZE * chunks.length + calcChunksDataSize(chunks);
}
async function createImage(header, chunks) {
	let blobBuilder = new BlobBuilder();
	let buffer = /* @__PURE__ */ new ArrayBuffer(28);
	let dataView = new DataView(buffer);
	let arrayView = new Uint8Array(buffer);
	dataView.setUint32(0, FILE_MAGIC, true);
	dataView.setUint16(4, MAJOR_VERSION, true);
	dataView.setUint16(6, MINOR_VERSION, true);
	dataView.setUint16(8, 28, true);
	dataView.setUint16(10, CHUNK_HEADER_SIZE, true);
	dataView.setUint32(12, header.blockSize, true);
	dataView.setUint32(16, header.blocks, true);
	dataView.setUint32(20, chunks.length, true);
	dataView.setUint32(24, 0, true);
	blobBuilder.append(new Blob([buffer]));
	for (let chunk of chunks) {
		buffer = new ArrayBuffer(CHUNK_HEADER_SIZE + chunk.data.size);
		dataView = new DataView(buffer);
		arrayView = new Uint8Array(buffer);
		dataView.setUint16(0, chunk.type, true);
		dataView.setUint16(2, 0, true);
		dataView.setUint32(4, chunk.blocks, true);
		dataView.setUint32(8, CHUNK_HEADER_SIZE + chunk.data.size, true);
		let chunkArrayView = new Uint8Array(await readBlobAsBuffer(chunk.data));
		arrayView.set(chunkArrayView, CHUNK_HEADER_SIZE);
		blobBuilder.append(new Blob([buffer]));
	}
	return blobBuilder.getBlob();
}
/**
* Creates a sparse image from buffer containing raw image data.
*
* @param {Blob} blob - Blob containing the raw image data.
* @returns {Promise<Blob>} Promise that resolves the blob containing the new sparse image.
*/
async function fromRaw(blob) {
	let header = {
		blockSize: 4096,
		blocks: blob.size / 4096,
		chunks: 1,
		crc32: 0
	};
	let chunks = [];
	while (blob.size > 0) {
		let chunkSize = Math.min(blob.size, RAW_CHUNK_SIZE);
		chunks.push({
			type: ChunkType.Raw,
			blocks: chunkSize / header.blockSize,
			data: blob.slice(0, chunkSize)
		});
		blob = blob.slice(chunkSize);
	}
	return createImage(header, chunks);
}
/**
* Split a sparse image into smaller sparse images within the given size.
* This takes a Blob instead of an ArrayBuffer because it may process images
* larger than RAM.
*
* @param {Blob} blob - Blob containing the sparse image to split.
* @param {number} splitSize - Maximum size per split.
* @yields {Object} Data of the next split image and its output size in bytes.
*/
async function* splitBlob(blob, splitSize) {
	logDebug(`Splitting ${blob.size}-byte sparse image into ${splitSize}-byte chunks`);
	const safeSendValue = Math.floor(splitSize * (7 / 8));
	if (blob.size <= splitSize) {
		logDebug("Blob fits in 1 payload, not splitting");
		yield {
			data: await readBlobAsBuffer(blob),
			bytes: blob.size
		};
		return;
	}
	let header = parseFileHeader(await readBlobAsBuffer(blob.slice(0, 28)));
	if (header === null) throw new ImageError("Blob is not a sparse image");
	header.crc32 = 0;
	blob = blob.slice(28);
	let splitChunks = [];
	let splitDataBytes = 0;
	for (let i = 0; i < header.chunks; i++) {
		let originalChunk = parseChunkHeader(await readBlobAsBuffer(blob.slice(0, CHUNK_HEADER_SIZE)));
		originalChunk.data = blob.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + originalChunk.dataBytes);
		blob = blob.slice(CHUNK_HEADER_SIZE + originalChunk.dataBytes);
		let chunksToProcess = [];
		if (originalChunk.dataBytes > safeSendValue) {
			logDebug(`Data of chunk ${i} is bigger than the maximum allowed download size: ${originalChunk.dataBytes} > ${safeSendValue}`);
			let originalDataBytes = originalChunk.dataBytes;
			let originalData = originalChunk.data;
			while (originalDataBytes > 0) {
				const toSend = Math.min(safeSendValue, originalDataBytes);
				chunksToProcess.push({
					type: originalChunk.type,
					dataBytes: toSend,
					data: originalData.slice(0, toSend),
					blocks: toSend / header?.blockSize
				});
				originalData = originalData.slice(toSend);
				originalDataBytes -= toSend;
			}
			logDebug("chunksToProcess", chunksToProcess);
		} else chunksToProcess.push(originalChunk);
		for (const chunk of chunksToProcess) {
			let bytesRemaining = splitSize - calcChunksSize(splitChunks);
			logVerbose(`  Chunk ${i}: type ${chunk.type}, ${chunk.dataBytes} bytes / ${chunk.blocks} blocks, ${bytesRemaining} bytes remaining`);
			if (bytesRemaining >= chunk.dataBytes) {
				logVerbose("    Space is available, adding chunk");
				splitChunks.push(chunk);
				splitDataBytes += chunk.blocks * header.blockSize;
			} else {
				let splitBlocks = calcChunksBlockSize(splitChunks);
				splitChunks.push({
					type: ChunkType.Skip,
					blocks: header.blocks - splitBlocks,
					data: new Blob([]),
					dataBytes: 0
				});
				logVerbose(`Partition is ${header.blocks} blocks, used ${splitBlocks}, padded with ${header.blocks - splitBlocks}, finishing split with ${calcChunksBlockSize(splitChunks)} blocks`);
				let splitImage = await createImage(header, splitChunks);
				logDebug(`Finished ${splitImage.size}-byte split with ${splitChunks.length} chunks`);
				yield {
					data: await readBlobAsBuffer(splitImage),
					bytes: splitDataBytes
				};
				logVerbose(`Starting new split: skipping first ${splitBlocks} blocks and adding chunk`);
				splitChunks = [{
					type: ChunkType.Skip,
					blocks: splitBlocks,
					data: new Blob([]),
					dataBytes: 0
				}, chunk];
				splitDataBytes = chunk.dataBytes;
			}
		}
	}
	if (splitChunks.length > 0 && (splitChunks.length > 1 || splitChunks[0].type !== ChunkType.Skip)) {
		let splitImage = await createImage(header, splitChunks);
		logDebug(`Finishing final ${splitImage.size}-byte split with ${splitChunks.length} chunks`);
		yield {
			data: await readBlobAsBuffer(splitImage),
			bytes: splitDataBytes
		};
	}
}
//#endregion
//#region src/lp.ts
const LP_METADATA_GEOMETRY_MAGIC = 1634485351;
const LP_METADATA_HEADER_MAGIC = 1095520304;
const LP_SECTOR_SIZE = 512;
const LP_METADATA_GEOMETRY_SIZE = 4096;
const LP_PARTITION_RESERVED_BYTES = 4096;
const LP_METADATA_MAJOR_VERSION = 10;
const LP_METADATA_MINOR_VERSION_MAX = 2;
const LP_METADATA_VERSION_FOR_UPDATED_ATTR = 1;
const LP_METADATA_VERSION_FOR_EXPANDED_HEADER = 2;
const GEOMETRY_STRUCT_SIZE = 52;
const HEADER_V1_0_SIZE = 128;
const HEADER_V1_2_SIZE = 256;
const PARTITION_STRUCT_SIZE = 52;
const EXTENT_STRUCT_SIZE = 24;
const GROUP_STRUCT_SIZE = 48;
const BLOCK_DEVICE_STRUCT_SIZE = 64;
const LP_BLOCK_DEVICE_SLOT_SUFFIXED = 1;
const LP_PARTITION_ATTR_READONLY = 1;
const LP_PARTITION_ATTR_SLOT_SUFFIXED = 2;
const LP_PARTITION_ATTR_UPDATED = 4;
const LP_PARTITION_ATTR_DISABLED = 8;
const LP_PARTITION_ATTRIBUTE_MASK_V0 = LP_PARTITION_ATTR_READONLY | LP_PARTITION_ATTR_SLOT_SUFFIXED;
const LP_PARTITION_ATTRIBUTE_MASK_V1 = LP_PARTITION_ATTR_UPDATED | LP_PARTITION_ATTR_DISABLED;
const LP_TARGET_TYPE_LINEAR = 0;
function nameFromFixedArray(view, offset, maxLen) {
	const bytes = [];
	for (let i = 0; i < maxLen; i++) {
		const b = view.getUint8(offset + i);
		if (b === 0) break;
		bytes.push(b);
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}
async function sha256(buffer) {
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	return new Uint8Array(digest);
}
function arraysEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
function concatBuffers(...buffers) {
	const totalLen = buffers.reduce((acc, b) => acc + b.byteLength, 0);
	const out = new Uint8Array(totalLen);
	let offset = 0;
	for (const buf of buffers) {
		out.set(new Uint8Array(buf), offset);
		offset += buf.byteLength;
	}
	return out.buffer;
}
function padBuffer(buf, size) {
	if (buf.byteLength === size) return buf;
	const out = new Uint8Array(size);
	out.set(new Uint8Array(buf.slice(0, Math.min(buf.byteLength, size))));
	return out.buffer;
}
async function parseGeometry(buffer) {
	if (buffer.byteLength < GEOMETRY_STRUCT_SIZE) throw new LpError("Geometry buffer too small");
	const view = new DataView(buffer);
	const magic = view.getUint32(0, true);
	if (magic !== LP_METADATA_GEOMETRY_MAGIC) throw new LpError(`Invalid geometry magic: 0x${magic.toString(16)}`);
	const structSize = view.getUint32(4, true);
	if (structSize > LP_METADATA_GEOMETRY_SIZE) throw new LpError(`Geometry struct_size ${structSize} exceeds LP_METADATA_GEOMETRY_SIZE`);
	const storedChecksum = new Uint8Array(buffer.slice(8, 40));
	const forHash = new Uint8Array(buffer.slice(0, structSize));
	forHash.fill(0, 8, 40);
	if (!arraysEqual(await sha256(forHash.buffer), storedChecksum)) throw new LpError("Geometry checksum mismatch");
	const metadataMaxSize = view.getUint32(40, true);
	const metadataSlotCount = view.getUint32(44, true);
	const logicalBlockSize = view.getUint32(48, true);
	if (structSize !== GEOMETRY_STRUCT_SIZE) throw new LpError(`Geometry struct_size ${structSize} does not match expected ${GEOMETRY_STRUCT_SIZE}`);
	if (metadataSlotCount === 0) throw new LpError("Geometry has invalid slot count (0)");
	if (metadataMaxSize % LP_SECTOR_SIZE !== 0) throw new LpError(`Geometry metadata_max_size ${metadataMaxSize} is not sector-aligned`);
	return {
		magic,
		structSize,
		checksum: storedChecksum,
		metadataMaxSize,
		metadataSlotCount,
		logicalBlockSize
	};
}
function parseTableDescriptor(view, offset) {
	return {
		offset: view.getUint32(offset + 0, true),
		numEntries: view.getUint32(offset + 4, true),
		entrySize: view.getUint32(offset + 8, true)
	};
}
function validateTableBounds(header, table) {
	if (table.offset > header.tablesSize) return false;
	const tableSize = table.numEntries * table.entrySize;
	if (tableSize < 0) return false;
	if (header.tablesSize - table.offset < tableSize) return false;
	return true;
}
async function parseHeader(buffer, tablesBuffer) {
	if (buffer.byteLength < HEADER_V1_0_SIZE) throw new LpError("Header buffer too small");
	const view = new DataView(buffer);
	const magic = view.getUint32(0, true);
	if (magic !== LP_METADATA_HEADER_MAGIC) throw new LpError(`Invalid header magic: 0x${magic.toString(16)}`);
	const majorVersion = view.getUint16(4, true);
	const minorVersion = view.getUint16(6, true);
	if (majorVersion !== LP_METADATA_MAJOR_VERSION) throw new LpError(`Unsupported LP metadata major version: ${majorVersion}`);
	if (minorVersion > LP_METADATA_MINOR_VERSION_MAX) throw new LpError(`Unsupported LP metadata minor version: ${minorVersion}`);
	const headerSize = view.getUint32(8, true);
	if (headerSize !== (minorVersion < LP_METADATA_VERSION_FOR_EXPANDED_HEADER ? HEADER_V1_0_SIZE : HEADER_V1_2_SIZE) || headerSize > buffer.byteLength) throw new LpError(`Invalid header size: ${headerSize}`);
	const storedChecksum = new Uint8Array(buffer.slice(12, 44));
	const forHash = new Uint8Array(buffer.slice(0, headerSize));
	forHash.fill(0, 12, 44);
	if (!arraysEqual(await sha256(forHash.buffer), storedChecksum)) throw new LpError("Header checksum mismatch");
	const tablesSize = view.getUint32(44, true);
	const tablesChecksum = new Uint8Array(buffer.slice(48, 80));
	if (tablesBuffer.byteLength < tablesSize) throw new LpError("Tables buffer too small");
	if (!arraysEqual(await sha256(tablesBuffer.slice(0, tablesSize)), tablesChecksum)) throw new LpError("Tables checksum mismatch");
	const partitions = parseTableDescriptor(view, 80);
	const extents = parseTableDescriptor(view, 92);
	const groups = parseTableDescriptor(view, 104);
	const blockDevices = parseTableDescriptor(view, 116);
	if (!validateTableBounds({ tablesSize }, partitions) || !validateTableBounds({ tablesSize }, extents) || !validateTableBounds({ tablesSize }, groups) || !validateTableBounds({ tablesSize }, blockDevices)) throw new LpError("Invalid table bounds in metadata header");
	return {
		magic,
		majorVersion,
		minorVersion,
		headerSize,
		headerChecksum: storedChecksum,
		tablesSize,
		tablesChecksum,
		partitions,
		extents,
		groups,
		blockDevices,
		flags: headerSize >= HEADER_V1_2_SIZE ? view.getUint32(128, true) : 0
	};
}
function parsePartition(view, offset) {
	return {
		name: nameFromFixedArray(view, offset + 0, 36),
		attributes: view.getUint32(offset + 36, true),
		firstExtentIndex: view.getUint32(offset + 40, true),
		numExtents: view.getUint32(offset + 44, true),
		groupIndex: view.getUint32(offset + 48, true)
	};
}
function parseExtent(view, offset) {
	return {
		numSectors: view.getBigUint64(offset + 0, true),
		targetType: view.getUint32(offset + 8, true),
		targetData: view.getBigUint64(offset + 12, true),
		targetSource: view.getUint32(offset + 20, true)
	};
}
function parseGroup(view, offset) {
	return {
		name: nameFromFixedArray(view, offset + 0, 36),
		flags: view.getUint32(offset + 36, true),
		maximumSize: view.getBigUint64(offset + 40, true)
	};
}
function parseBlockDevice(view, offset) {
	return {
		firstLogicalSector: view.getBigUint64(offset + 0, true),
		alignment: view.getUint32(offset + 8, true),
		alignmentOffset: view.getUint32(offset + 12, true),
		size: view.getBigUint64(offset + 16, true),
		partitionName: nameFromFixedArray(view, offset + 24, 36),
		flags: view.getUint32(offset + 60, true)
	};
}
function parseTable(tablesView, descriptor, expectedEntrySize, parser) {
	if (descriptor.entrySize !== expectedEntrySize) throw new LpError(`Table entry size mismatch: expected ${expectedEntrySize}, got ${descriptor.entrySize}`);
	const tableSize = descriptor.numEntries * descriptor.entrySize;
	if (descriptor.offset > tablesView.byteLength || tableSize > tablesView.byteLength - descriptor.offset) throw new LpError("Table descriptor points outside tables buffer");
	const results = [];
	for (let i = 0; i < descriptor.numEntries; i++) {
		const offset = descriptor.offset + i * descriptor.entrySize;
		results.push(parser(tablesView, offset));
	}
	return results;
}
function validateParsedMetadata(geometry, header, partitions, extents, groups, blockDevices) {
	const superDevice = blockDevices[0];
	if (!superDevice) throw new LpError("Metadata does not specify a super block device");
	const validAttributes = header.minorVersion >= LP_METADATA_VERSION_FOR_UPDATED_ATTR ? LP_PARTITION_ATTRIBUTE_MASK_V0 | LP_PARTITION_ATTRIBUTE_MASK_V1 : LP_PARTITION_ATTRIBUTE_MASK_V0;
	for (const partition of partitions) {
		if (partition.attributes & ~validAttributes) throw new LpError(`Partition "${partition.name}" has invalid attributes`);
		const end = partition.firstExtentIndex + partition.numExtents;
		if (end < partition.firstExtentIndex || end > extents.length) throw new LpError(`Partition "${partition.name}" has invalid extent list`);
		if (partition.groupIndex >= groups.length) throw new LpError(`Partition "${partition.name}" has invalid group index`);
	}
	for (const extent of extents) if (extent.targetType === LP_TARGET_TYPE_LINEAR && extent.targetSource >= blockDevices.length) throw new LpError("Linear extent references invalid block device");
	if (BigInt(LP_PARTITION_RESERVED_BYTES) + BigInt(LP_METADATA_GEOMETRY_SIZE + geometry.metadataMaxSize * geometry.metadataSlotCount) * 2n > superDevice.firstLogicalSector * BigInt(LP_SECTOR_SIZE)) throw new LpError("Metadata region overlaps with logical partition contents");
}
/**
* Parse LP metadata from a super_empty.img Blob.
*
* super_empty.img layout:
*   [0 .. LP_METADATA_GEOMETRY_SIZE)  — geometry struct (4096 bytes)
*   [LP_METADATA_GEOMETRY_SIZE ..)    — header + tables (metadata slot 0)
*/
async function readFromImageBlob(blob) {
	logDebug(`Parsing LP metadata from ${blob.size}-byte image`);
	const primaryGeometryOffset = 0;
	const geometry = await parseGeometry(await readBlobAsBuffer(blob.slice(primaryGeometryOffset, primaryGeometryOffset + LP_METADATA_GEOMETRY_SIZE)));
	logDebug(`LP geometry: maxSize=${geometry.metadataMaxSize}, slotCount=${geometry.metadataSlotCount}, blockSize=${geometry.logicalBlockSize}`);
	const headerPeekOffset = LP_METADATA_GEOMETRY_SIZE;
	const headerPeekBuf = await readBlobAsBuffer(blob.slice(headerPeekOffset, headerPeekOffset + HEADER_V1_0_SIZE));
	const peekView = new DataView(headerPeekBuf);
	const headerSize = peekView.getUint32(8, true);
	const tablesSize = peekView.getUint32(44, true);
	if (tablesSize > geometry.metadataMaxSize) throw new LpError("Metadata tables exceed geometry.metadata_max_size");
	const headerBuf = await readBlobAsBuffer(blob.slice(headerPeekOffset, headerPeekOffset + headerSize));
	const tablesBuf = await readBlobAsBuffer(blob.slice(headerPeekOffset + headerSize, headerPeekOffset + headerSize + tablesSize));
	const header = await parseHeader(headerBuf, tablesBuf);
	logDebug(`LP header: v${header.majorVersion}.${header.minorVersion}, headerSize=${header.headerSize}`);
	const tablesView = new DataView(tablesBuf);
	const partitions = parseTable(tablesView, header.partitions, PARTITION_STRUCT_SIZE, parsePartition);
	const extents = parseTable(tablesView, header.extents, EXTENT_STRUCT_SIZE, parseExtent);
	const groups = parseTable(tablesView, header.groups, GROUP_STRUCT_SIZE, parseGroup);
	const blockDevices = parseTable(tablesView, header.blockDevices, BLOCK_DEVICE_STRUCT_SIZE, parseBlockDevice);
	validateParsedMetadata(geometry, header, partitions, extents, groups, blockDevices);
	logDebug(`LP: ${partitions.length} partitions, ${blockDevices.length} block device(s)`);
	for (const bd of blockDevices) logDebug(`  block device "${bd.partitionName}": size=${bd.size}, flags=0x${bd.flags.toString(16)}`);
	return {
		geometry,
		header,
		partitions,
		extents,
		groups,
		blockDevices
	};
}
function getMetadataSuperBlockDevice(metadata) {
	return metadata.blockDevices[0] ?? null;
}
function getBlockDevicePartitionName(bd) {
	return bd.partitionName;
}
async function serializeGeometry(geometry) {
	const buf = new ArrayBuffer(GEOMETRY_STRUCT_SIZE);
	const view = new DataView(buf);
	view.setUint32(0, geometry.magic, true);
	view.setUint32(4, geometry.structSize, true);
	view.setUint32(40, geometry.metadataMaxSize, true);
	view.setUint32(44, geometry.metadataSlotCount, true);
	view.setUint32(48, geometry.logicalBlockSize, true);
	const checksum = await sha256(buf);
	new Uint8Array(buf).set(checksum, 8);
	return padBuffer(buf, LP_METADATA_GEOMETRY_SIZE);
}
function serializeTableDescriptor(view, offset, desc) {
	view.setUint32(offset + 0, desc.offset, true);
	view.setUint32(offset + 4, desc.numEntries, true);
	view.setUint32(offset + 8, desc.entrySize, true);
}
function serializeNameToFixedArray(view, offset, name, maxLen) {
	const encoded = new TextEncoder().encode(name);
	for (let i = 0; i < maxLen; i++) view.setUint8(offset + i, i < encoded.length ? encoded[i] : 0);
}
function serializePartition(partition) {
	const buf = new ArrayBuffer(PARTITION_STRUCT_SIZE);
	const view = new DataView(buf);
	serializeNameToFixedArray(view, 0, partition.name, 36);
	view.setUint32(36, partition.attributes, true);
	view.setUint32(40, partition.firstExtentIndex, true);
	view.setUint32(44, partition.numExtents, true);
	view.setUint32(48, partition.groupIndex, true);
	return buf;
}
function serializeExtent(extent) {
	const buf = new ArrayBuffer(EXTENT_STRUCT_SIZE);
	const view = new DataView(buf);
	view.setBigUint64(0, extent.numSectors, true);
	view.setUint32(8, extent.targetType, true);
	view.setBigUint64(12, extent.targetData, true);
	view.setUint32(20, extent.targetSource, true);
	return buf;
}
function serializeGroup(group) {
	const buf = new ArrayBuffer(GROUP_STRUCT_SIZE);
	const view = new DataView(buf);
	serializeNameToFixedArray(view, 0, group.name, 36);
	view.setUint32(36, group.flags, true);
	view.setBigUint64(40, group.maximumSize, true);
	return buf;
}
function serializeBlockDevice(bd) {
	const buf = new ArrayBuffer(BLOCK_DEVICE_STRUCT_SIZE);
	const view = new DataView(buf);
	view.setBigUint64(0, bd.firstLogicalSector, true);
	view.setUint32(8, bd.alignment, true);
	view.setUint32(12, bd.alignmentOffset, true);
	view.setBigUint64(16, bd.size, true);
	serializeNameToFixedArray(view, 24, bd.partitionName, 36);
	view.setUint32(60, bd.flags, true);
	return buf;
}
async function serializeMetadata(metadata) {
	const { header, geometry } = metadata;
	const partitionBufs = metadata.partitions.map(serializePartition);
	const extentBufs = metadata.extents.map(serializeExtent);
	const groupBufs = metadata.groups.map(serializeGroup);
	const blockDevBufs = metadata.blockDevices.map(serializeBlockDevice);
	const tablesBuffer = concatBuffers(...[
		...partitionBufs,
		...extentBufs,
		...groupBufs,
		...blockDevBufs
	]);
	const partitionsOffset = 0;
	const extentsOffset = partitionBufs.reduce((s, b) => s + b.byteLength, 0);
	const groupsOffset = extentsOffset + extentBufs.reduce((s, b) => s + b.byteLength, 0);
	const blockDevicesOffset = groupsOffset + groupBufs.reduce((s, b) => s + b.byteLength, 0);
	const tablesChecksum = await sha256(tablesBuffer);
	const tablesSize = tablesBuffer.byteLength;
	const headerSize = header.minorVersion < LP_METADATA_VERSION_FOR_EXPANDED_HEADER ? HEADER_V1_0_SIZE : HEADER_V1_2_SIZE;
	const headerBuf = new ArrayBuffer(headerSize);
	const hv = new DataView(headerBuf);
	hv.setUint32(0, LP_METADATA_HEADER_MAGIC, true);
	hv.setUint16(4, header.majorVersion, true);
	hv.setUint16(6, header.minorVersion, true);
	hv.setUint32(8, headerSize, true);
	hv.setUint32(44, tablesSize, true);
	new Uint8Array(headerBuf).set(tablesChecksum, 48);
	const hDescView = new DataView(headerBuf);
	serializeTableDescriptor(hDescView, 80, {
		offset: partitionsOffset,
		numEntries: metadata.partitions.length,
		entrySize: PARTITION_STRUCT_SIZE
	});
	serializeTableDescriptor(hDescView, 92, {
		offset: extentsOffset,
		numEntries: metadata.extents.length,
		entrySize: EXTENT_STRUCT_SIZE
	});
	serializeTableDescriptor(hDescView, 104, {
		offset: groupsOffset,
		numEntries: metadata.groups.length,
		entrySize: GROUP_STRUCT_SIZE
	});
	serializeTableDescriptor(hDescView, 116, {
		offset: blockDevicesOffset,
		numEntries: metadata.blockDevices.length,
		entrySize: BLOCK_DEVICE_STRUCT_SIZE
	});
	if (headerSize >= HEADER_V1_2_SIZE) hv.setUint32(128, header.flags, true);
	const headerChecksum = await sha256(headerBuf);
	new Uint8Array(headerBuf).set(headerChecksum, 12);
	return concatBuffers(headerBuf, tablesBuffer);
}
/**
* Generate sparse images suitable for flashing to wipe the super partition.
*
* The first block device image contains the LP metadata region (reserved zeros +
* geometry copies + metadata slots) followed by a skip chunk for the remaining
* device space.  Secondary block devices (retrofit) get a skip-only image.
*/
async function buildWipeSuperImages(metadata) {
	const { geometry } = metadata;
	const blockSize = geometry.logicalBlockSize;
	if (blockSize % LP_SECTOR_SIZE !== 0) throw new LpError(`Block size ${blockSize} must be a multiple of sector size ${LP_SECTOR_SIZE}`);
	if (LP_METADATA_GEOMETRY_SIZE % blockSize !== 0) throw new LpError(`Geometry size ${LP_METADATA_GEOMETRY_SIZE} is not a multiple of block size ${blockSize}`);
	if (LP_PARTITION_RESERVED_BYTES % blockSize !== 0) throw new LpError(`Reserved size ${LP_PARTITION_RESERVED_BYTES} is not a multiple of block size ${blockSize}`);
	if (geometry.metadataMaxSize % blockSize !== 0) throw new LpError(`Metadata max size ${geometry.metadataMaxSize} must be a multiple of block size ${blockSize}`);
	const [geomBuf, rawMetaBuf] = await Promise.all([serializeGeometry(geometry), serializeMetadata(metadata)]);
	const metaBuf = padBuffer(rawMetaBuf, geometry.metadataMaxSize);
	const slotCount = geometry.metadataSlotCount;
	const allMetadata = concatBuffers(...[
		geomBuf,
		geomBuf,
		...Array(slotCount).fill(metaBuf),
		...Array(slotCount).fill(metaBuf)
	]);
	const metadataBlocks = allMetadata.byteLength / blockSize;
	const reservedBlocks = LP_PARTITION_RESERVED_BYTES / blockSize;
	const results = [];
	for (let i = 0; i < metadata.blockDevices.length; i++) {
		const bd = metadata.blockDevices[i];
		const partitionName = getBlockDevicePartitionName(bd);
		const forceSlot = !!(bd.flags & LP_BLOCK_DEVICE_SLOT_SUFFIXED);
		if (bd.size % BigInt(blockSize) !== 0n) throw new LpError(`Device "${partitionName}" size ${bd.size} is not a multiple of block size ${blockSize}`);
		const deviceBlocks = Number(bd.size) / blockSize;
		if (deviceBlocks >= 4294967295) throw new LpError(`Device "${partitionName}" is too large to encode with sparse format`);
		let sparseBlob;
		if (i === 0) {
			const skipBlocks = deviceBlocks - reservedBlocks - metadataBlocks;
			if (skipBlocks < 0) throw new LpError(`Device "${partitionName}" is too small to hold LP metadata`);
			sparseBlob = await createImage({
				blockSize,
				blocks: deviceBlocks,
				chunks: 3,
				crc32: 0
			}, [
				{
					type: ChunkType.Fill,
					blocks: reservedBlocks,
					dataBytes: 4,
					data: new Blob([new Uint32Array([0]).buffer])
				},
				{
					type: ChunkType.Raw,
					blocks: metadataBlocks,
					dataBytes: allMetadata.byteLength,
					data: new Blob([allMetadata])
				},
				{
					type: ChunkType.Skip,
					blocks: skipBlocks,
					dataBytes: 0,
					data: new Blob([])
				}
			]);
		} else sparseBlob = await createImage({
			blockSize,
			blocks: deviceBlocks,
			chunks: 1,
			crc32: 0
		}, [{
			type: ChunkType.Skip,
			blocks: deviceBlocks,
			dataBytes: 0,
			data: new Blob([])
		}]);
		const data = await readBlobAsBuffer(sparseBlob);
		logDebug(`Generated ${data.byteLength}-byte sparse image for "${partitionName}"`);
		results.push({
			partitionName,
			data,
			forceSlot
		});
	}
	return results;
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/constants.js
const MAX_32_BITS = 4294967295;
const MAX_16_BITS = 65535;
const END_OF_CENTRAL_DIR_SIGNATURE = 101010256;
const EXTRAFIELD_TYPE_AES = 39169;
const EXTRAFIELD_TYPE_EXTENDED_TIMESTAMP = 21589;
const EXTRAFIELD_TYPE_UNICODE_PATH = 28789;
const EXTRAFIELD_TYPE_UNICODE_COMMENT = 25461;
const EXTRAFIELD_TYPE_USDZ = 6534;
const EXTRAFIELD_TYPE_INFOZIP = 30837;
const EXTRAFIELD_TYPE_UNIX = 30805;
const BITFLAG_LANG_ENCODING_FLAG = 2048;
const FILE_ATTR_UNIX_TYPE_MASK = 61440;
const FILE_ATTR_UNIX_TYPE_DIR = 16384;
const FILE_ATTR_UNIX_SETUID_MASK = 2048;
const FILE_ATTR_UNIX_SETGID_MASK = 1024;
const INFINITY_VALUE = Infinity;
const UNDEFINED_TYPE = "undefined";
const FUNCTION_TYPE = "function";
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/configuration.js
const MINIMUM_CHUNK_SIZE = 64;
let maxWorkers = 2;
try {
	if (typeof navigator != "undefined" && navigator.hardwareConcurrency) maxWorkers = navigator.hardwareConcurrency;
} catch {}
const config = Object.assign({}, {
	workerURI: "./core/web-worker-wasm.js",
	wasmURI: "./core/streams/zlib-wasm/zlib-streams.wasm",
	chunkSize: 64 * 1024,
	maxWorkers,
	terminateWorkerTimeout: 5e3,
	useWebWorkers: true,
	useCompressionStream: true,
	CompressionStream: typeof CompressionStream != "undefined" && CompressionStream,
	DecompressionStream: typeof DecompressionStream != "undefined" && DecompressionStream
});
function getConfiguration() {
	return config;
}
function getChunkSize(config) {
	return Math.max(config.chunkSize, MINIMUM_CHUNK_SIZE);
}
function configure(configuration) {
	const { baseURI, chunkSize, maxWorkers, terminateWorkerTimeout, useCompressionStream, useWebWorkers, CompressionStream, DecompressionStream, CompressionStreamZlib, DecompressionStreamZlib, workerURI, wasmURI } = configuration;
	setIfDefined("baseURI", baseURI);
	setIfDefined("wasmURI", wasmURI);
	setIfDefined("workerURI", workerURI);
	setIfDefined("chunkSize", chunkSize);
	setIfDefined("maxWorkers", maxWorkers);
	setIfDefined("terminateWorkerTimeout", terminateWorkerTimeout);
	setIfDefined("useCompressionStream", useCompressionStream);
	setIfDefined("useWebWorkers", useWebWorkers);
	setIfDefined("CompressionStream", CompressionStream);
	setIfDefined("DecompressionStream", DecompressionStream);
	setIfDefined("CompressionStreamZlib", CompressionStreamZlib);
	setIfDefined("DecompressionStreamZlib", DecompressionStreamZlib);
}
function setIfDefined(propertyName, propertyValue) {
	if (propertyValue !== void 0) config[propertyName] = propertyValue;
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/web-worker-inline-wasm.js
function t(t) {
	const e = "(t=>{\"function\"==typeof define&&define.amd?define(t):t()})(function(){\"use strict\";const{Array:t,Object:e,Number:n,Math:s,Error:r,Uint8Array:o,Uint16Array:i,Uint32Array:c,Int32Array:a,Map:h,DataView:f,Promise:l,TextEncoder:u,crypto:w,postMessage:p,TransformStream:d,ReadableStream:y,WritableStream:m,CompressionStream:g,DecompressionStream:S}=self,b=void 0,v=\"undefined\",k=\"function\",z=[];for(let t=0;256>t;t++){let e=t;for(let t=0;8>t;t++)1&e?e=e>>>1^3988292384:e>>>=1;z[t]=e}class C{constructor(t){this.t=t||-1}append(t){let e=0|this.t;for(let n=0,s=0|t.length;s>n;n++)e=e>>>8^z[255&(e^t[n])];this.t=e}get(){return~this.t}}class A extends d{constructor(){let t;const e=new C;super({transform(t,n){e.append(t),n.enqueue(t)},flush(){const n=new o(4);new f(n.buffer).setUint32(0,e.get()),t.value=n}}),t=this}}const x={concat(t,e){if(0===t.length||0===e.length)return t.concat(e);const n=t[t.length-1],s=x.o(n);return 32===s?t.concat(e):x.i(e,s,0|n,t.slice(0,t.length-1))},h(t){const e=t.length;if(0===e)return 0;const n=t[e-1];return 32*(e-1)+x.o(n)},l(t,e){if(32*t.length<e)return t;const n=(t=t.slice(0,s.ceil(e/32))).length;return e&=31,n>0&&e&&(t[n-1]=x.u(e,t[n-1]&2147483648>>e-1,1)),t},u:(t,e,n)=>32===t?e:(n?0|e:e<<32-t)+1099511627776*t,o:t=>s.round(t/1099511627776)||32,i(t,e,n,s){for(void 0===s&&(s=[]);e>=32;e-=32)s.push(n),n=0;if(0===e)return s.concat(t);for(let r=0;r<t.length;r++)s.push(n|t[r]>>>e),n=t[r]<<32-e;const r=t.length?t[t.length-1]:0,o=x.o(r);return s.push(x.u(e+o&31,e+o>32?n:s.pop(),1)),s}},I={bytes:{p(t){const e=x.h(t)/8,n=new o(e);let s;for(let r=0;e>r;r++)3&r||(s=t[r/4]),n[r]=s>>>24,s<<=8;return n},m(t){const e=[];let n,s=0;for(n=0;n<t.length;n++)s=s<<8|t[n],3&~n||(e.push(s),s=0);return 3&n&&e.push(x.u(8*(3&n),s)),e}}},R=class{constructor(t){const e=this;e.blockSize=512,e.S=[1732584193,4023233417,2562383102,271733878,3285377520],e.v=[1518500249,1859775393,2400959708,3395469782],t?(e.k=t.k.slice(0),e.C=t.C.slice(0),e.A=t.A):e.reset()}reset(){const t=this;return t.k=t.S.slice(0),t.C=[],t.A=0,t}update(t){const e=this;\"string\"==typeof t&&(t=I.I.m(t));const n=e.C=x.concat(e.C,t),s=e.A,o=e.A=s+x.h(t);if(o>9007199254740991)throw new r(\"Cannot hash more than 2^53 - 1 bits\");const i=new c(n);let a=0;for(let t=e.blockSize+s-(e.blockSize+s&e.blockSize-1);o>=t;t+=e.blockSize)e.R(i.subarray(16*a,16*(a+1))),a+=1;return n.splice(0,16*a),e}P(){const t=this;let e=t.C;const n=t.k;e=x.concat(e,[x.u(1,1)]);for(let t=e.length+2;15&t;t++)e.push(0);for(e.push(s.floor(t.A/4294967296)),e.push(0|t.A);e.length;)t.R(e.splice(0,16));return t.reset(),n}U(t,e,n,s){return t>19?t>39?t>59?t>79?void 0:e^n^s:e&n|e&s|n&s:e^n^s:e&n|~e&s}V(t,e){return e<<t|e>>>32-t}R(e){const n=this,r=n.k,o=t(80);for(let t=0;16>t;t++)o[t]=e[t];let i=r[0],c=r[1],a=r[2],h=r[3],f=r[4];for(let t=0;79>=t;t++){16>t||(o[t]=n.V(1,o[t-3]^o[t-8]^o[t-14]^o[t-16]));const e=n.V(5,i)+n.U(t,c,a,h)+f+o[t]+n.v[s.floor(t/20)]|0;f=h,h=a,a=n.V(30,c),c=i,i=e}r[0]=r[0]+i|0,r[1]=r[1]+c|0,r[2]=r[2]+a|0,r[3]=r[3]+h|0,r[4]=r[4]+f|0}},P={getRandomValues(t){const e=new c(t.buffer),n=t=>{let e=987654321;const n=4294967295;return()=>(e=36969*(65535&e)+(e>>16)&n,(((e<<16)+(t=18e3*(65535&t)+(t>>16)&n)&n)/4294967296+.5)*(s.random()>.5?1:-1))};for(let r,o=0;o<t.length;o+=4){const t=n(4294967296*(r||s.random()));r=987654071*t(),e[o/4]=4294967296*t()|0}return t}},U={importKey:t=>new U.M(I.bytes.m(t)),_(t,e,n,s){if(n=n||1e4,0>s||0>n)throw new r(\"invalid params to pbkdf2\");const o=1+(s>>5)<<2;let i,c,a,h,l;const u=new ArrayBuffer(o),w=new f(u);let p=0;const d=x;for(e=I.bytes.m(e),l=1;(o||1)>p;l++){for(i=c=t.encrypt(d.concat(e,[l])),a=1;n>a;a++)for(c=t.encrypt(c),h=0;h<c.length;h++)i[h]^=c[h];for(a=0;(o||1)>p&&a<i.length;a++)w.setInt32(p,i[a]),p+=4}return u.slice(0,s/8)},M:class{constructor(t){const e=this,n=e.B=R,s=[[],[]];e.D=[new n,new n];const r=e.D[0].blockSize/32;t.length>r&&(t=(new n).update(t).P());for(let e=0;r>e;e++)s[0][e]=909522486^t[e],s[1][e]=1549556828^t[e];e.D[0].update(s[0]),e.D[1].update(s[1]),e.W=new n(e.D[0])}reset(){const t=this;t.W=new t.B(t.D[0]),t.K=!1}update(t){this.K=!0,this.W.update(t)}digest(){const t=this,e=t.W.P(),n=new t.B(t.D[1]).update(e).P();return t.reset(),n}encrypt(t){if(this.K)throw new r(\"encrypt on already updated hmac called!\");return this.update(t),this.digest(t)}}},V=typeof w!=v&&typeof w.getRandomValues==k,M=\"Invalid password\",_=\"Invalid signature\",B=\"zipjs-abort-check-password\";function D(t){return V?w.getRandomValues(t):P.getRandomValues(t)}const W=16,K={name:\"PBKDF2\"},E=e.assign({hash:{name:\"HMAC\"}},K),L=e.assign({iterations:1e3,hash:{name:\"SHA-1\"}},K),O=[\"deriveBits\"],T=[8,12,16],j=[16,24,32],H=10,Z=[0,0,0,0],F=typeof w!=v,N=F&&w.subtle,q=F&&typeof N!=v,G=I.bytes,J=class{constructor(t){const e=this;e.L=[[[],[],[],[],[]],[[],[],[],[],[]]],e.L[0][0][0]||e.O();const n=e.L[0][4],s=e.L[1],o=t.length;let i,c,a,h=1;if(4!==o&&6!==o&&8!==o)throw new r(\"invalid aes key size\");for(e.v=[c=t.slice(0),a=[]],i=o;4*o+28>i;i++){let t=c[i-1];(i%o===0||8===o&&i%o===4)&&(t=n[t>>>24]<<24^n[t>>16&255]<<16^n[t>>8&255]<<8^n[255&t],i%o===0&&(t=t<<8^t>>>24^h<<24,h=h<<1^283*(h>>7))),c[i]=c[i-o]^t}for(let t=0;i;t++,i--){const e=c[3&t?i:i-4];a[t]=4>=i||4>t?e:s[0][n[e>>>24]]^s[1][n[e>>16&255]]^s[2][n[e>>8&255]]^s[3][n[255&e]]}}encrypt(t){return this.T(t,0)}decrypt(t){return this.T(t,1)}O(){const t=this.L[0],e=this.L[1],n=t[4],s=e[4],r=[],o=[];let i,c,a,h;for(let t=0;256>t;t++)o[(r[t]=t<<1^283*(t>>7))^t]=t;for(let f=i=0;!n[f];f^=c||1,i=o[i]||1){let o=i^i<<1^i<<2^i<<3^i<<4;o=o>>8^255&o^99,n[f]=o,s[o]=f,h=r[a=r[c=r[f]]];let l=16843009*h^65537*a^257*c^16843008*f,u=257*r[o]^16843008*o;for(let n=0;4>n;n++)t[n][f]=u=u<<24^u>>>8,e[n][o]=l=l<<24^l>>>8}for(let n=0;5>n;n++)t[n]=t[n].slice(0),e[n]=e[n].slice(0)}T(t,e){if(4!==t.length)throw new r(\"invalid aes block size\");const n=this.v[e],s=n.length/4-2,o=[0,0,0,0],i=this.L[e],c=i[0],a=i[1],h=i[2],f=i[3],l=i[4];let u,w,p,d=t[0]^n[0],y=t[e?3:1]^n[1],m=t[2]^n[2],g=t[e?1:3]^n[3],S=4;for(let t=0;s>t;t++)u=c[d>>>24]^a[y>>16&255]^h[m>>8&255]^f[255&g]^n[S],w=c[y>>>24]^a[m>>16&255]^h[g>>8&255]^f[255&d]^n[S+1],p=c[m>>>24]^a[g>>16&255]^h[d>>8&255]^f[255&y]^n[S+2],g=c[g>>>24]^a[d>>16&255]^h[y>>8&255]^f[255&m]^n[S+3],S+=4,d=u,y=w,m=p;for(let t=0;4>t;t++)o[e?3&-t:t]=l[d>>>24]<<24^l[y>>16&255]<<16^l[m>>8&255]<<8^l[255&g]^n[S++],u=d,d=y,y=m,m=g,g=u;return o}},Q=class{constructor(t,e){this.j=t,this.H=e,this.Z=e}reset(){this.Z=this.H}update(t){return this.F(this.j,t,this.Z)}N(t){if(255&~(t>>24))t+=1<<24;else{let e=t>>16&255,n=t>>8&255,s=255&t;255===e?(e=0,255===n?(n=0,255===s?s=0:++s):++n):++e,t=0,t+=e<<16,t+=n<<8,t+=s}return t}q(t){0===(t[0]=this.N(t[0]))&&(t[1]=this.N(t[1]))}F(t,e,n){let s;if(!(s=e.length))return[];const r=x.h(e);for(let r=0;s>r;r+=4){this.q(n);const s=t.encrypt(n);e[r]^=s[0],e[r+1]^=s[1],e[r+2]^=s[2],e[r+3]^=s[3]}return x.l(e,r)}},X=U.M;let Y=F&&q&&typeof N.importKey==k,$=F&&q&&typeof N.deriveBits==k;class tt extends d{constructor({password:t,rawPassword:n,signed:s,encryptionStrength:i,checkPasswordOnly:c}){super({start(){e.assign(this,{ready:new l(t=>this.G=t),password:rt(t,n),signed:s,J:i-1,pending:new o})},async transform(t,e){const n=this,{password:s,J:i,G:a,ready:h}=n;s?(await(async(t,e,n,s)=>{const o=await st(t,e,n,it(s,0,T[e])),i=it(s,T[e]);if(o[0]!=i[0]||o[1]!=i[1])throw new r(M)})(n,i,s,it(t,0,T[i]+2)),t=it(t,T[i]+2),c?e.error(new r(B)):a()):await h;const f=new o(t.length-H-(t.length-H)%W);e.enqueue(nt(n,t,f,0,H,!0))},async flush(t){const{signed:e,X:n,Y:s,pending:i,ready:c}=this;if(s&&n){await c;const a=it(i,0,i.length-H),h=it(i,i.length-H);let f=new o;if(a.length){const t=at(G,a);s.update(t);const e=n.update(t);f=ct(G,e)}if(e){const t=it(ct(G,s.digest()),0,H);for(let e=0;H>e;e++)if(t[e]!=h[e])throw new r(_)}t.enqueue(f)}}})}}class et extends d{constructor({password:t,rawPassword:n,encryptionStrength:s}){let r;super({start(){e.assign(this,{ready:new l(t=>this.G=t),password:rt(t,n),J:s-1,pending:new o})},async transform(t,e){const n=this,{password:s,J:r,G:i,ready:c}=n;let a=new o;s?(a=await(async(t,e,n)=>{const s=D(new o(T[e]));return ot(s,await st(t,e,n,s))})(n,r,s),i()):await c;const h=new o(a.length+t.length-t.length%W);h.set(a,0),e.enqueue(nt(n,t,h,a.length,0))},async flush(t){const{X:e,Y:n,pending:s,ready:i}=this;if(n&&e){await i;let c=new o;if(s.length){const t=e.update(at(G,s));n.update(t),c=ct(G,t)}r.signature=ct(G,n.digest()).slice(0,H),t.enqueue(ot(c,r.signature))}}}),r=this}}function nt(t,e,n,s,r,i){const{X:c,Y:a,pending:h}=t,f=e.length-r;let l;for(h.length&&(e=ot(h,e),n=((t,e)=>{if(e&&e>t.length){const n=t;(t=new o(e)).set(n,0)}return t})(n,f-f%W)),l=0;f-W>=l;l+=W){const t=at(G,it(e,l,l+W));i&&a.update(t);const r=c.update(t);i||a.update(r),n.set(ct(G,r),l+s)}return t.pending=it(e,l),n}async function st(n,s,r,i){n.password=null;const c=await(async(t,e,n,s,r)=>{if(!Y)return U.importKey(e);try{return await N.importKey(\"raw\",e,n,!1,r)}catch{return Y=!1,U.importKey(e)}})(0,r,E,0,O),a=await(async(t,e,n)=>{if(!$)return U._(e,t.salt,L.iterations,n);try{return await N.deriveBits(t,e,n)}catch{return $=!1,U._(e,t.salt,L.iterations,n)}})(e.assign({salt:i},L),c,8*(2*j[s]+2)),h=new o(a),f=at(G,it(h,0,j[s])),l=at(G,it(h,j[s],2*j[s])),u=it(h,2*j[s]);return e.assign(n,{keys:{key:f,$:l,passwordVerification:u},X:new Q(new J(f),t.from(Z)),Y:new X(l)}),u}function rt(t,e){return e===b?(t=>{if(typeof u==v){const e=new o((t=unescape(encodeURIComponent(t))).length);for(let n=0;n<e.length;n++)e[n]=t.charCodeAt(n);return e}return(new u).encode(t)})(t):e}function ot(t,e){let n=t;return t.length+e.length&&(n=new o(t.length+e.length),n.set(t,0),n.set(e,t.length)),n}function it(t,e,n){return t.subarray(e,n)}function ct(t,e){return t.p(e)}function at(t,e){return t.m(e)}class ht extends d{constructor({password:t,passwordVerification:n,checkPasswordOnly:s}){super({start(){e.assign(this,{password:t,passwordVerification:n}),wt(this,t)},transform(t,e){const n=this;if(n.password){const e=lt(n,t.subarray(0,12));if(n.password=null,e.at(-1)!=n.passwordVerification)throw new r(M);t=t.subarray(12)}s?e.error(new r(B)):e.enqueue(lt(n,t))}})}}class ft extends d{constructor({password:t,passwordVerification:n}){super({start(){e.assign(this,{password:t,passwordVerification:n}),wt(this,t)},transform(t,e){const n=this;let s,r;if(n.password){n.password=null;const e=D(new o(12));e[11]=n.passwordVerification,s=new o(t.length+e.length),s.set(ut(n,e),0),r=12}else s=new o(t.length),r=0;s.set(ut(n,t),r),e.enqueue(s)}})}}function lt(t,e){const n=new o(e.length);for(let s=0;s<e.length;s++)n[s]=dt(t)^e[s],pt(t,n[s]);return n}function ut(t,e){const n=new o(e.length);for(let s=0;s<e.length;s++)n[s]=dt(t)^e[s],pt(t,e[s]);return n}function wt(t,n){const s=[305419896,591751049,878082192];e.assign(t,{keys:s,tt:new C(s[0]),et:new C(s[2])});for(let e=0;e<n.length;e++)pt(t,n.charCodeAt(e))}function pt(t,e){let[n,r,o]=t.keys;t.tt.append([e]),n=~t.tt.get(),r=mt(s.imul(mt(r+yt(n)),134775813)+1),t.et.append([r>>>24]),o=~t.et.get(),t.keys=[n,r,o]}function dt(t){const e=2|t.keys[2];return yt(s.imul(e,1^e)>>>8)}function yt(t){return 255&t}function mt(t){return 4294967295&t}class gt extends d{constructor(t,{chunkSize:e,nt:n,CompressionStream:s}){super({});const{compressed:r,encrypted:o,useCompressionStream:i,zipCrypto:c,signed:a,level:h}=t,l=this;let u,w,p=super.readable;o&&!c||!a||(u=new A,p=kt(p,u)),r&&(p=vt(p,i,{level:h,chunkSize:e},s,n,s)),o&&(c?p=kt(p,new ft(t)):(w=new et(t),p=kt(p,w))),bt(l,p,()=>{let t;o&&!c&&(t=w.signature),o&&!c||!a||(t=new f(u.value.buffer).getUint32(0)),l.signature=t})}}class St extends d{constructor(t,{chunkSize:e,st:n,DecompressionStream:s}){super({});const{zipCrypto:o,encrypted:i,signed:c,signature:a,compressed:h,useCompressionStream:l,rt:u}=t;let w,p,d=super.readable;i&&(o?d=kt(d,new ht(t)):(p=new tt(t),d=kt(d,p))),h&&(d=vt(d,l,{chunkSize:e,rt:u},s,n,s)),i&&!o||!c||(w=new A,d=kt(d,w)),bt(this,d,()=>{if((!i||o)&&c){const t=new f(w.value.buffer);if(a!=t.getUint32(0,!1))throw new r(_)}})}}function bt(t,n,s){n=kt(n,new d({flush:s})),e.defineProperty(t,\"readable\",{get:()=>n})}function vt(t,e,n,s,r,o){const i=e&&s?s:r||o,c=n.rt?\"deflate64-raw\":\"deflate-raw\";try{t=kt(t,new i(c,n))}catch(s){if(!e)throw s;if(r)t=kt(t,new r(c,n));else{if(!o)throw s;t=kt(t,new o(c,n))}}return t}function kt(t,e){return t.pipeThrough(e)}const zt=\"data\",Ct=\"close\";class At extends d{constructor(t,n){super({});const s=this,{codecType:o}=t;let i;o.startsWith(\"deflate\")?i=gt:o.startsWith(\"inflate\")&&(i=St),s.outputSize=0;let c=0;const a=new i(t,n),h=super.readable,f=new d({transform(t,e){t&&t.length&&(c+=t.length,e.enqueue(t))},flush(){e.assign(s,{inputSize:c})}}),l=new d({transform(e,n){if(e&&e.length&&(n.enqueue(e),s.outputSize+=e.length,t.outputSize!==b&&s.outputSize>t.outputSize))throw new r(\"Invalid uncompressed size\")},flush(){const{signature:t}=a;e.assign(s,{signature:t,inputSize:c})}});e.defineProperty(s,\"readable\",{get:()=>h.pipeThrough(f).pipeThrough(a).pipeThrough(l)})}}class xt extends d{constructor(t){let e;super({transform:function n(s,r){if(e){const t=new o(e.length+s.length);t.set(e),t.set(s,e.length),s=t,e=null}s.length>t?(r.enqueue(s.slice(0,t)),n(s.slice(t),r)):e=s},flush(t){e&&e.length&&t.enqueue(e)}})}}const It=new h,Rt=new h;let Pt,Ut,Vt,Mt,_t,Bt=0;async function Dt(t){try{const{options:e,config:s}=t;if(!e.useCompressionStream)try{await self.initModule(t.config)}catch{e.useCompressionStream=!0}s.CompressionStream=self.CompressionStream,s.DecompressionStream=self.DecompressionStream;const r={highWaterMark:1},o=t.readable||new y({async pull(t){const e=new l(t=>It.set(Bt,t));Wt({type:\"pull\",messageId:Bt}),Bt=(Bt+1)%n.MAX_SAFE_INTEGER;const{value:s,done:r}=await e;t.enqueue(s),r&&t.close()}},r),i=t.writable||new m({async write(t){let e;const s=new l(t=>e=t);Rt.set(Bt,e),Wt({type:zt,value:t,messageId:Bt}),Bt=(Bt+1)%n.MAX_SAFE_INTEGER,await s}},r),c=new At(e,s);Pt=new AbortController;const{signal:a}=Pt;await o.pipeThrough(c).pipeThrough(new xt(s.chunkSize)).pipeTo(i,{signal:a,preventClose:!0,preventAbort:!0}),await i.getWriter().close();const{signature:h,inputSize:f,outputSize:u}=c;Wt({type:Ct,result:{signature:h,inputSize:f,outputSize:u}})}catch(t){t.outputSize=0,Kt(t)}}function Wt(t){let{value:e}=t;if(e)if(e.length)try{e=new o(e),t.value=e.buffer,p(t,[t.value])}catch{p(t)}else p(t);else p(t)}function Kt(t=new r(\"Unknown error\")){const{message:e,stack:n,code:s,name:o,outputSize:i}=t;p({error:{message:e,stack:n,code:s,name:o,outputSize:i}})}function Et(t,e,n={}){const i=\"number\"==typeof n.level?n.level:-1,c=\"number\"==typeof n.ot?n.ot:65536,a=\"number\"==typeof n.it?n.it:65536;return new d({start(){let n;if(this.ct=Vt(c),this.in=Vt(a),this.it=a,this.ht=new o(c),t?(this.ft=Ut.deflate_process,this.lt=Ut.deflate_last_consumed,this.ut=Ut.deflate_end,this.wt=Ut.deflate_new(),n=\"gzip\"===e?Ut.deflate_init_gzip(this.wt,i):\"deflate-raw\"===e?Ut.deflate_init_raw(this.wt,i):Ut.deflate_init(this.wt,i)):\"deflate64-raw\"===e?(this.ft=Ut.inflate9_process,this.lt=Ut.inflate9_last_consumed,this.ut=Ut.inflate9_end,this.wt=Ut.inflate9_new(),n=Ut.inflate9_init_raw(this.wt)):(this.ft=Ut.inflate_process,this.lt=Ut.inflate_last_consumed,this.ut=Ut.inflate_end,this.wt=Ut.inflate_new(),n=\"deflate-raw\"===e?Ut.inflate_init_raw(this.wt):\"gzip\"===e?Ut.inflate_init_gzip(this.wt):Ut.inflate_init(this.wt)),0!==n)throw new r(\"init failed:\"+n)},transform(e,n){try{const i=e,a=new o(_t.buffer),h=this.ft,f=this.lt,l=this.ct,u=this.ht;let w=0;for(;w<i.length;){const e=s.min(i.length-w,32768);this.in&&this.it>=e||(this.in&&Mt&&Mt(this.in),this.in=Vt(e),this.it=e),a.set(i.subarray(w,w+e),this.in);const o=h(this.wt,this.in,e,l,c,0),p=16777215&o;if(p&&(u.set(a.subarray(l,l+p),0),n.enqueue(u.slice(0,p))),!t){const t=o>>24&255,e=128&t?t-256:t;if(0>e)throw new r(\"process error:\"+e)}const d=f(this.wt);if(0===d)break;w+=d}}catch(t){this.ut&&this.wt&&this.ut(this.wt),this.in&&Mt&&Mt(this.in),this.ct&&Mt&&Mt(this.ct),n.error(t)}},flush(e){try{const n=new o(_t.buffer),s=this.ft,i=this.ct,a=this.ht;for(;;){const o=s(this.wt,0,0,i,c,4),h=16777215&o,f=o>>24&255;if(!t){const t=128&f?f-256:f;if(0>t)throw new r(\"process error:\"+t)}if(h&&(a.set(n.subarray(i,i+h),0),e.enqueue(a.slice(0,h))),1===f||0===h)break}}catch(t){e.error(t)}finally{if(this.ut&&this.wt){const t=this.ut(this.wt);0!==t&&e.error(new r(\"end error:\"+t))}this.in&&Mt&&Mt(this.in),this.ct&&Mt&&Mt(this.ct)}}})}addEventListener(\"message\",({data:t})=>{const{type:e,messageId:n,value:s,done:r}=t;try{if(\"start\"==e&&Dt(t),e==zt){const t=It.get(n);It.delete(n),t({value:new o(s),done:r})}if(\"ack\"==e){const t=Rt.get(n);Rt.delete(n),t()}e==Ct&&Pt.abort()}catch(t){Kt(t)}});class Lt{constructor(t=\"deflate\",e){return Et(!0,t,e)}}class Ot{constructor(t=\"deflate\",e){return Et(!1,t,e)}}let Tt=!1;self.initModule=async t=>{try{const e=await(async(t,{baseURI:e})=>{if(!Tt){let n,s;try{try{s=new URL(t,e)}catch{}const r=await fetch(s);n=await r.arrayBuffer()}catch(e){if(!t.startsWith(\"data:application/wasm;base64,\"))throw e;n=(t=>{const e=t.split(\",\")[1],n=atob(e),s=n.length,r=new o(s);for(let t=0;s>t;++t)r[t]=n.charCodeAt(t);return r.buffer})(t)}(t=>{if(Ut=t,({malloc:Vt,free:Mt,memory:_t}=Ut),\"function\"!=typeof Vt||\"function\"!=typeof Mt||!_t)throw Ut=Vt=Mt=_t=null,new r(\"Invalid WASM module\")})((await WebAssembly.instantiate(n)).instance.exports),Tt=!0}})(t.wasmURI,t);return t.nt=Lt,t.st=Ot,e}catch{}}});\n";
	t({ workerURI: (t) => {
		const n = "text/javascript";
		if (t) {
			const t = new Blob([e], { type: n });
			return URL.createObjectURL(t);
		}
		return "data:" + n + ",(t%3D%3E%7B%22function%22%3D%3Dtypeof%20define%26%26define.amd%3Fdefine(t)%3At()%7D)(function()%7B%22use%20strict%22%3Bconst%7BArray%3At%2CObject%3Ae%2CNumber%3An%2CMath%3As%2CError%3Ar%2CUint8Array%3Ao%2CUint16Array%3Ai%2CUint32Array%3Ac%2CInt32Array%3Aa%2CMap%3Ah%2CDataView%3Af%2CPromise%3Al%2CTextEncoder%3Au%2Ccrypto%3Aw%2CpostMessage%3Ap%2CTransformStream%3Ad%2CReadableStream%3Ay%2CWritableStream%3Am%2CCompressionStream%3Ag%2CDecompressionStream%3AS%7D%3Dself%2Cb%3Dvoid%200%2Cv%3D%22undefined%22%2Ck%3D%22function%22%2Cz%3D%5B%5D%3Bfor(let%20t%3D0%3B256%3Et%3Bt%2B%2B)%7Blet%20e%3Dt%3Bfor(let%20t%3D0%3B8%3Et%3Bt%2B%2B)1%26e%3Fe%3De%3E%3E%3E1%5E3988292384%3Ae%3E%3E%3E%3D1%3Bz%5Bt%5D%3De%7Dclass%20C%7Bconstructor(t)%7Bthis.t%3Dt%7C%7C-1%7Dappend(t)%7Blet%20e%3D0%7Cthis.t%3Bfor(let%20n%3D0%2Cs%3D0%7Ct.length%3Bs%3En%3Bn%2B%2B)e%3De%3E%3E%3E8%5Ez%5B255%26(e%5Et%5Bn%5D)%5D%3Bthis.t%3De%7Dget()%7Breturn~this.t%7D%7Dclass%20A%20extends%20d%7Bconstructor()%7Blet%20t%3Bconst%20e%3Dnew%20C%3Bsuper(%7Btransform(t%2Cn)%7Be.append(t)%2Cn.enqueue(t)%7D%2Cflush()%7Bconst%20n%3Dnew%20o(4)%3Bnew%20f(n.buffer).setUint32(0%2Ce.get())%2Ct.value%3Dn%7D%7D)%2Ct%3Dthis%7D%7Dconst%20x%3D%7Bconcat(t%2Ce)%7Bif(0%3D%3D%3Dt.length%7C%7C0%3D%3D%3De.length)return%20t.concat(e)%3Bconst%20n%3Dt%5Bt.length-1%5D%2Cs%3Dx.o(n)%3Breturn%2032%3D%3D%3Ds%3Ft.concat(e)%3Ax.i(e%2Cs%2C0%7Cn%2Ct.slice(0%2Ct.length-1))%7D%2Ch(t)%7Bconst%20e%3Dt.length%3Bif(0%3D%3D%3De)return%200%3Bconst%20n%3Dt%5Be-1%5D%3Breturn%2032*(e-1)%2Bx.o(n)%7D%2Cl(t%2Ce)%7Bif(32*t.length%3Ce)return%20t%3Bconst%20n%3D(t%3Dt.slice(0%2Cs.ceil(e%2F32))).length%3Breturn%20e%26%3D31%2Cn%3E0%26%26e%26%26(t%5Bn-1%5D%3Dx.u(e%2Ct%5Bn-1%5D%262147483648%3E%3Ee-1%2C1))%2Ct%7D%2Cu%3A(t%2Ce%2Cn)%3D%3E32%3D%3D%3Dt%3Fe%3A(n%3F0%7Ce%3Ae%3C%3C32-t)%2B1099511627776*t%2Co%3At%3D%3Es.round(t%2F1099511627776)%7C%7C32%2Ci(t%2Ce%2Cn%2Cs)%7Bfor(void%200%3D%3D%3Ds%26%26(s%3D%5B%5D)%3Be%3E%3D32%3Be-%3D32)s.push(n)%2Cn%3D0%3Bif(0%3D%3D%3De)return%20s.concat(t)%3Bfor(let%20r%3D0%3Br%3Ct.length%3Br%2B%2B)s.push(n%7Ct%5Br%5D%3E%3E%3Ee)%2Cn%3Dt%5Br%5D%3C%3C32-e%3Bconst%20r%3Dt.length%3Ft%5Bt.length-1%5D%3A0%2Co%3Dx.o(r)%3Breturn%20s.push(x.u(e%2Bo%2631%2Ce%2Bo%3E32%3Fn%3As.pop()%2C1))%2Cs%7D%7D%2CI%3D%7Bbytes%3A%7Bp(t)%7Bconst%20e%3Dx.h(t)%2F8%2Cn%3Dnew%20o(e)%3Blet%20s%3Bfor(let%20r%3D0%3Be%3Er%3Br%2B%2B)3%26r%7C%7C(s%3Dt%5Br%2F4%5D)%2Cn%5Br%5D%3Ds%3E%3E%3E24%2Cs%3C%3C%3D8%3Breturn%20n%7D%2Cm(t)%7Bconst%20e%3D%5B%5D%3Blet%20n%2Cs%3D0%3Bfor(n%3D0%3Bn%3Ct.length%3Bn%2B%2B)s%3Ds%3C%3C8%7Ct%5Bn%5D%2C3%26~n%7C%7C(e.push(s)%2Cs%3D0)%3Breturn%203%26n%26%26e.push(x.u(8*(3%26n)%2Cs))%2Ce%7D%7D%7D%2CR%3Dclass%7Bconstructor(t)%7Bconst%20e%3Dthis%3Be.blockSize%3D512%2Ce.S%3D%5B1732584193%2C4023233417%2C2562383102%2C271733878%2C3285377520%5D%2Ce.v%3D%5B1518500249%2C1859775393%2C2400959708%2C3395469782%5D%2Ct%3F(e.k%3Dt.k.slice(0)%2Ce.C%3Dt.C.slice(0)%2Ce.A%3Dt.A)%3Ae.reset()%7Dreset()%7Bconst%20t%3Dthis%3Breturn%20t.k%3Dt.S.slice(0)%2Ct.C%3D%5B%5D%2Ct.A%3D0%2Ct%7Dupdate(t)%7Bconst%20e%3Dthis%3B%22string%22%3D%3Dtypeof%20t%26%26(t%3DI.I.m(t))%3Bconst%20n%3De.C%3Dx.concat(e.C%2Ct)%2Cs%3De.A%2Co%3De.A%3Ds%2Bx.h(t)%3Bif(o%3E9007199254740991)throw%20new%20r(%22Cannot%20hash%20more%20than%202%5E53%20-%201%20bits%22)%3Bconst%20i%3Dnew%20c(n)%3Blet%20a%3D0%3Bfor(let%20t%3De.blockSize%2Bs-(e.blockSize%2Bs%26e.blockSize-1)%3Bo%3E%3Dt%3Bt%2B%3De.blockSize)e.R(i.subarray(16*a%2C16*(a%2B1)))%2Ca%2B%3D1%3Breturn%20n.splice(0%2C16*a)%2Ce%7DP()%7Bconst%20t%3Dthis%3Blet%20e%3Dt.C%3Bconst%20n%3Dt.k%3Be%3Dx.concat(e%2C%5Bx.u(1%2C1)%5D)%3Bfor(let%20t%3De.length%2B2%3B15%26t%3Bt%2B%2B)e.push(0)%3Bfor(e.push(s.floor(t.A%2F4294967296))%2Ce.push(0%7Ct.A)%3Be.length%3B)t.R(e.splice(0%2C16))%3Breturn%20t.reset()%2Cn%7DU(t%2Ce%2Cn%2Cs)%7Breturn%20t%3E19%3Ft%3E39%3Ft%3E59%3Ft%3E79%3Fvoid%200%3Ae%5En%5Es%3Ae%26n%7Ce%26s%7Cn%26s%3Ae%5En%5Es%3Ae%26n%7C~e%26s%7DV(t%2Ce)%7Breturn%20e%3C%3Ct%7Ce%3E%3E%3E32-t%7DR(e)%7Bconst%20n%3Dthis%2Cr%3Dn.k%2Co%3Dt(80)%3Bfor(let%20t%3D0%3B16%3Et%3Bt%2B%2B)o%5Bt%5D%3De%5Bt%5D%3Blet%20i%3Dr%5B0%5D%2Cc%3Dr%5B1%5D%2Ca%3Dr%5B2%5D%2Ch%3Dr%5B3%5D%2Cf%3Dr%5B4%5D%3Bfor(let%20t%3D0%3B79%3E%3Dt%3Bt%2B%2B)%7B16%3Et%7C%7C(o%5Bt%5D%3Dn.V(1%2Co%5Bt-3%5D%5Eo%5Bt-8%5D%5Eo%5Bt-14%5D%5Eo%5Bt-16%5D))%3Bconst%20e%3Dn.V(5%2Ci)%2Bn.U(t%2Cc%2Ca%2Ch)%2Bf%2Bo%5Bt%5D%2Bn.v%5Bs.floor(t%2F20)%5D%7C0%3Bf%3Dh%2Ch%3Da%2Ca%3Dn.V(30%2Cc)%2Cc%3Di%2Ci%3De%7Dr%5B0%5D%3Dr%5B0%5D%2Bi%7C0%2Cr%5B1%5D%3Dr%5B1%5D%2Bc%7C0%2Cr%5B2%5D%3Dr%5B2%5D%2Ba%7C0%2Cr%5B3%5D%3Dr%5B3%5D%2Bh%7C0%2Cr%5B4%5D%3Dr%5B4%5D%2Bf%7C0%7D%7D%2CP%3D%7BgetRandomValues(t)%7Bconst%20e%3Dnew%20c(t.buffer)%2Cn%3Dt%3D%3E%7Blet%20e%3D987654321%3Bconst%20n%3D4294967295%3Breturn()%3D%3E(e%3D36969*(65535%26e)%2B(e%3E%3E16)%26n%2C(((e%3C%3C16)%2B(t%3D18e3*(65535%26t)%2B(t%3E%3E16)%26n)%26n)%2F4294967296%2B.5)*(s.random()%3E.5%3F1%3A-1))%7D%3Bfor(let%20r%2Co%3D0%3Bo%3Ct.length%3Bo%2B%3D4)%7Bconst%20t%3Dn(4294967296*(r%7C%7Cs.random()))%3Br%3D987654071*t()%2Ce%5Bo%2F4%5D%3D4294967296*t()%7C0%7Dreturn%20t%7D%7D%2CU%3D%7BimportKey%3At%3D%3Enew%20U.M(I.bytes.m(t))%2C_(t%2Ce%2Cn%2Cs)%7Bif(n%3Dn%7C%7C1e4%2C0%3Es%7C%7C0%3En)throw%20new%20r(%22invalid%20params%20to%20pbkdf2%22)%3Bconst%20o%3D1%2B(s%3E%3E5)%3C%3C2%3Blet%20i%2Cc%2Ca%2Ch%2Cl%3Bconst%20u%3Dnew%20ArrayBuffer(o)%2Cw%3Dnew%20f(u)%3Blet%20p%3D0%3Bconst%20d%3Dx%3Bfor(e%3DI.bytes.m(e)%2Cl%3D1%3B(o%7C%7C1)%3Ep%3Bl%2B%2B)%7Bfor(i%3Dc%3Dt.encrypt(d.concat(e%2C%5Bl%5D))%2Ca%3D1%3Bn%3Ea%3Ba%2B%2B)for(c%3Dt.encrypt(c)%2Ch%3D0%3Bh%3Cc.length%3Bh%2B%2B)i%5Bh%5D%5E%3Dc%5Bh%5D%3Bfor(a%3D0%3B(o%7C%7C1)%3Ep%26%26a%3Ci.length%3Ba%2B%2B)w.setInt32(p%2Ci%5Ba%5D)%2Cp%2B%3D4%7Dreturn%20u.slice(0%2Cs%2F8)%7D%2CM%3Aclass%7Bconstructor(t)%7Bconst%20e%3Dthis%2Cn%3De.B%3DR%2Cs%3D%5B%5B%5D%2C%5B%5D%5D%3Be.D%3D%5Bnew%20n%2Cnew%20n%5D%3Bconst%20r%3De.D%5B0%5D.blockSize%2F32%3Bt.length%3Er%26%26(t%3D(new%20n).update(t).P())%3Bfor(let%20e%3D0%3Br%3Ee%3Be%2B%2B)s%5B0%5D%5Be%5D%3D909522486%5Et%5Be%5D%2Cs%5B1%5D%5Be%5D%3D1549556828%5Et%5Be%5D%3Be.D%5B0%5D.update(s%5B0%5D)%2Ce.D%5B1%5D.update(s%5B1%5D)%2Ce.W%3Dnew%20n(e.D%5B0%5D)%7Dreset()%7Bconst%20t%3Dthis%3Bt.W%3Dnew%20t.B(t.D%5B0%5D)%2Ct.K%3D!1%7Dupdate(t)%7Bthis.K%3D!0%2Cthis.W.update(t)%7Ddigest()%7Bconst%20t%3Dthis%2Ce%3Dt.W.P()%2Cn%3Dnew%20t.B(t.D%5B1%5D).update(e).P()%3Breturn%20t.reset()%2Cn%7Dencrypt(t)%7Bif(this.K)throw%20new%20r(%22encrypt%20on%20already%20updated%20hmac%20called!%22)%3Breturn%20this.update(t)%2Cthis.digest(t)%7D%7D%7D%2CV%3Dtypeof%20w!%3Dv%26%26typeof%20w.getRandomValues%3D%3Dk%2CM%3D%22Invalid%20password%22%2C_%3D%22Invalid%20signature%22%2CB%3D%22zipjs-abort-check-password%22%3Bfunction%20D(t)%7Breturn%20V%3Fw.getRandomValues(t)%3AP.getRandomValues(t)%7Dconst%20W%3D16%2CK%3D%7Bname%3A%22PBKDF2%22%7D%2CE%3De.assign(%7Bhash%3A%7Bname%3A%22HMAC%22%7D%7D%2CK)%2CL%3De.assign(%7Biterations%3A1e3%2Chash%3A%7Bname%3A%22SHA-1%22%7D%7D%2CK)%2CO%3D%5B%22deriveBits%22%5D%2CT%3D%5B8%2C12%2C16%5D%2Cj%3D%5B16%2C24%2C32%5D%2CH%3D10%2CZ%3D%5B0%2C0%2C0%2C0%5D%2CF%3Dtypeof%20w!%3Dv%2CN%3DF%26%26w.subtle%2Cq%3DF%26%26typeof%20N!%3Dv%2CG%3DI.bytes%2CJ%3Dclass%7Bconstructor(t)%7Bconst%20e%3Dthis%3Be.L%3D%5B%5B%5B%5D%2C%5B%5D%2C%5B%5D%2C%5B%5D%2C%5B%5D%5D%2C%5B%5B%5D%2C%5B%5D%2C%5B%5D%2C%5B%5D%2C%5B%5D%5D%5D%2Ce.L%5B0%5D%5B0%5D%5B0%5D%7C%7Ce.O()%3Bconst%20n%3De.L%5B0%5D%5B4%5D%2Cs%3De.L%5B1%5D%2Co%3Dt.length%3Blet%20i%2Cc%2Ca%2Ch%3D1%3Bif(4!%3D%3Do%26%266!%3D%3Do%26%268!%3D%3Do)throw%20new%20r(%22invalid%20aes%20key%20size%22)%3Bfor(e.v%3D%5Bc%3Dt.slice(0)%2Ca%3D%5B%5D%5D%2Ci%3Do%3B4*o%2B28%3Ei%3Bi%2B%2B)%7Blet%20t%3Dc%5Bi-1%5D%3B(i%25o%3D%3D%3D0%7C%7C8%3D%3D%3Do%26%26i%25o%3D%3D%3D4)%26%26(t%3Dn%5Bt%3E%3E%3E24%5D%3C%3C24%5En%5Bt%3E%3E16%26255%5D%3C%3C16%5En%5Bt%3E%3E8%26255%5D%3C%3C8%5En%5B255%26t%5D%2Ci%25o%3D%3D%3D0%26%26(t%3Dt%3C%3C8%5Et%3E%3E%3E24%5Eh%3C%3C24%2Ch%3Dh%3C%3C1%5E283*(h%3E%3E7)))%2Cc%5Bi%5D%3Dc%5Bi-o%5D%5Et%7Dfor(let%20t%3D0%3Bi%3Bt%2B%2B%2Ci--)%7Bconst%20e%3Dc%5B3%26t%3Fi%3Ai-4%5D%3Ba%5Bt%5D%3D4%3E%3Di%7C%7C4%3Et%3Fe%3As%5B0%5D%5Bn%5Be%3E%3E%3E24%5D%5D%5Es%5B1%5D%5Bn%5Be%3E%3E16%26255%5D%5D%5Es%5B2%5D%5Bn%5Be%3E%3E8%26255%5D%5D%5Es%5B3%5D%5Bn%5B255%26e%5D%5D%7D%7Dencrypt(t)%7Breturn%20this.T(t%2C0)%7Ddecrypt(t)%7Breturn%20this.T(t%2C1)%7DO()%7Bconst%20t%3Dthis.L%5B0%5D%2Ce%3Dthis.L%5B1%5D%2Cn%3Dt%5B4%5D%2Cs%3De%5B4%5D%2Cr%3D%5B%5D%2Co%3D%5B%5D%3Blet%20i%2Cc%2Ca%2Ch%3Bfor(let%20t%3D0%3B256%3Et%3Bt%2B%2B)o%5B(r%5Bt%5D%3Dt%3C%3C1%5E283*(t%3E%3E7))%5Et%5D%3Dt%3Bfor(let%20f%3Di%3D0%3B!n%5Bf%5D%3Bf%5E%3Dc%7C%7C1%2Ci%3Do%5Bi%5D%7C%7C1)%7Blet%20o%3Di%5Ei%3C%3C1%5Ei%3C%3C2%5Ei%3C%3C3%5Ei%3C%3C4%3Bo%3Do%3E%3E8%5E255%26o%5E99%2Cn%5Bf%5D%3Do%2Cs%5Bo%5D%3Df%2Ch%3Dr%5Ba%3Dr%5Bc%3Dr%5Bf%5D%5D%5D%3Blet%20l%3D16843009*h%5E65537*a%5E257*c%5E16843008*f%2Cu%3D257*r%5Bo%5D%5E16843008*o%3Bfor(let%20n%3D0%3B4%3En%3Bn%2B%2B)t%5Bn%5D%5Bf%5D%3Du%3Du%3C%3C24%5Eu%3E%3E%3E8%2Ce%5Bn%5D%5Bo%5D%3Dl%3Dl%3C%3C24%5El%3E%3E%3E8%7Dfor(let%20n%3D0%3B5%3En%3Bn%2B%2B)t%5Bn%5D%3Dt%5Bn%5D.slice(0)%2Ce%5Bn%5D%3De%5Bn%5D.slice(0)%7DT(t%2Ce)%7Bif(4!%3D%3Dt.length)throw%20new%20r(%22invalid%20aes%20block%20size%22)%3Bconst%20n%3Dthis.v%5Be%5D%2Cs%3Dn.length%2F4-2%2Co%3D%5B0%2C0%2C0%2C0%5D%2Ci%3Dthis.L%5Be%5D%2Cc%3Di%5B0%5D%2Ca%3Di%5B1%5D%2Ch%3Di%5B2%5D%2Cf%3Di%5B3%5D%2Cl%3Di%5B4%5D%3Blet%20u%2Cw%2Cp%2Cd%3Dt%5B0%5D%5En%5B0%5D%2Cy%3Dt%5Be%3F3%3A1%5D%5En%5B1%5D%2Cm%3Dt%5B2%5D%5En%5B2%5D%2Cg%3Dt%5Be%3F1%3A3%5D%5En%5B3%5D%2CS%3D4%3Bfor(let%20t%3D0%3Bs%3Et%3Bt%2B%2B)u%3Dc%5Bd%3E%3E%3E24%5D%5Ea%5By%3E%3E16%26255%5D%5Eh%5Bm%3E%3E8%26255%5D%5Ef%5B255%26g%5D%5En%5BS%5D%2Cw%3Dc%5By%3E%3E%3E24%5D%5Ea%5Bm%3E%3E16%26255%5D%5Eh%5Bg%3E%3E8%26255%5D%5Ef%5B255%26d%5D%5En%5BS%2B1%5D%2Cp%3Dc%5Bm%3E%3E%3E24%5D%5Ea%5Bg%3E%3E16%26255%5D%5Eh%5Bd%3E%3E8%26255%5D%5Ef%5B255%26y%5D%5En%5BS%2B2%5D%2Cg%3Dc%5Bg%3E%3E%3E24%5D%5Ea%5Bd%3E%3E16%26255%5D%5Eh%5By%3E%3E8%26255%5D%5Ef%5B255%26m%5D%5En%5BS%2B3%5D%2CS%2B%3D4%2Cd%3Du%2Cy%3Dw%2Cm%3Dp%3Bfor(let%20t%3D0%3B4%3Et%3Bt%2B%2B)o%5Be%3F3%26-t%3At%5D%3Dl%5Bd%3E%3E%3E24%5D%3C%3C24%5El%5By%3E%3E16%26255%5D%3C%3C16%5El%5Bm%3E%3E8%26255%5D%3C%3C8%5El%5B255%26g%5D%5En%5BS%2B%2B%5D%2Cu%3Dd%2Cd%3Dy%2Cy%3Dm%2Cm%3Dg%2Cg%3Du%3Breturn%20o%7D%7D%2CQ%3Dclass%7Bconstructor(t%2Ce)%7Bthis.j%3Dt%2Cthis.H%3De%2Cthis.Z%3De%7Dreset()%7Bthis.Z%3Dthis.H%7Dupdate(t)%7Breturn%20this.F(this.j%2Ct%2Cthis.Z)%7DN(t)%7Bif(255%26~(t%3E%3E24))t%2B%3D1%3C%3C24%3Belse%7Blet%20e%3Dt%3E%3E16%26255%2Cn%3Dt%3E%3E8%26255%2Cs%3D255%26t%3B255%3D%3D%3De%3F(e%3D0%2C255%3D%3D%3Dn%3F(n%3D0%2C255%3D%3D%3Ds%3Fs%3D0%3A%2B%2Bs)%3A%2B%2Bn)%3A%2B%2Be%2Ct%3D0%2Ct%2B%3De%3C%3C16%2Ct%2B%3Dn%3C%3C8%2Ct%2B%3Ds%7Dreturn%20t%7Dq(t)%7B0%3D%3D%3D(t%5B0%5D%3Dthis.N(t%5B0%5D))%26%26(t%5B1%5D%3Dthis.N(t%5B1%5D))%7DF(t%2Ce%2Cn)%7Blet%20s%3Bif(!(s%3De.length))return%5B%5D%3Bconst%20r%3Dx.h(e)%3Bfor(let%20r%3D0%3Bs%3Er%3Br%2B%3D4)%7Bthis.q(n)%3Bconst%20s%3Dt.encrypt(n)%3Be%5Br%5D%5E%3Ds%5B0%5D%2Ce%5Br%2B1%5D%5E%3Ds%5B1%5D%2Ce%5Br%2B2%5D%5E%3Ds%5B2%5D%2Ce%5Br%2B3%5D%5E%3Ds%5B3%5D%7Dreturn%20x.l(e%2Cr)%7D%7D%2CX%3DU.M%3Blet%20Y%3DF%26%26q%26%26typeof%20N.importKey%3D%3Dk%2C%24%3DF%26%26q%26%26typeof%20N.deriveBits%3D%3Dk%3Bclass%20tt%20extends%20d%7Bconstructor(%7Bpassword%3At%2CrawPassword%3An%2Csigned%3As%2CencryptionStrength%3Ai%2CcheckPasswordOnly%3Ac%7D)%7Bsuper(%7Bstart()%7Be.assign(this%2C%7Bready%3Anew%20l(t%3D%3Ethis.G%3Dt)%2Cpassword%3Art(t%2Cn)%2Csigned%3As%2CJ%3Ai-1%2Cpending%3Anew%20o%7D)%7D%2Casync%20transform(t%2Ce)%7Bconst%20n%3Dthis%2C%7Bpassword%3As%2CJ%3Ai%2CG%3Aa%2Cready%3Ah%7D%3Dn%3Bs%3F(await(async(t%2Ce%2Cn%2Cs)%3D%3E%7Bconst%20o%3Dawait%20st(t%2Ce%2Cn%2Cit(s%2C0%2CT%5Be%5D))%2Ci%3Dit(s%2CT%5Be%5D)%3Bif(o%5B0%5D!%3Di%5B0%5D%7C%7Co%5B1%5D!%3Di%5B1%5D)throw%20new%20r(M)%7D)(n%2Ci%2Cs%2Cit(t%2C0%2CT%5Bi%5D%2B2))%2Ct%3Dit(t%2CT%5Bi%5D%2B2)%2Cc%3Fe.error(new%20r(B))%3Aa())%3Aawait%20h%3Bconst%20f%3Dnew%20o(t.length-H-(t.length-H)%25W)%3Be.enqueue(nt(n%2Ct%2Cf%2C0%2CH%2C!0))%7D%2Casync%20flush(t)%7Bconst%7Bsigned%3Ae%2CX%3An%2CY%3As%2Cpending%3Ai%2Cready%3Ac%7D%3Dthis%3Bif(s%26%26n)%7Bawait%20c%3Bconst%20a%3Dit(i%2C0%2Ci.length-H)%2Ch%3Dit(i%2Ci.length-H)%3Blet%20f%3Dnew%20o%3Bif(a.length)%7Bconst%20t%3Dat(G%2Ca)%3Bs.update(t)%3Bconst%20e%3Dn.update(t)%3Bf%3Dct(G%2Ce)%7Dif(e)%7Bconst%20t%3Dit(ct(G%2Cs.digest())%2C0%2CH)%3Bfor(let%20e%3D0%3BH%3Ee%3Be%2B%2B)if(t%5Be%5D!%3Dh%5Be%5D)throw%20new%20r(_)%7Dt.enqueue(f)%7D%7D%7D)%7D%7Dclass%20et%20extends%20d%7Bconstructor(%7Bpassword%3At%2CrawPassword%3An%2CencryptionStrength%3As%7D)%7Blet%20r%3Bsuper(%7Bstart()%7Be.assign(this%2C%7Bready%3Anew%20l(t%3D%3Ethis.G%3Dt)%2Cpassword%3Art(t%2Cn)%2CJ%3As-1%2Cpending%3Anew%20o%7D)%7D%2Casync%20transform(t%2Ce)%7Bconst%20n%3Dthis%2C%7Bpassword%3As%2CJ%3Ar%2CG%3Ai%2Cready%3Ac%7D%3Dn%3Blet%20a%3Dnew%20o%3Bs%3F(a%3Dawait(async(t%2Ce%2Cn)%3D%3E%7Bconst%20s%3DD(new%20o(T%5Be%5D))%3Breturn%20ot(s%2Cawait%20st(t%2Ce%2Cn%2Cs))%7D)(n%2Cr%2Cs)%2Ci())%3Aawait%20c%3Bconst%20h%3Dnew%20o(a.length%2Bt.length-t.length%25W)%3Bh.set(a%2C0)%2Ce.enqueue(nt(n%2Ct%2Ch%2Ca.length%2C0))%7D%2Casync%20flush(t)%7Bconst%7BX%3Ae%2CY%3An%2Cpending%3As%2Cready%3Ai%7D%3Dthis%3Bif(n%26%26e)%7Bawait%20i%3Blet%20c%3Dnew%20o%3Bif(s.length)%7Bconst%20t%3De.update(at(G%2Cs))%3Bn.update(t)%2Cc%3Dct(G%2Ct)%7Dr.signature%3Dct(G%2Cn.digest()).slice(0%2CH)%2Ct.enqueue(ot(c%2Cr.signature))%7D%7D%7D)%2Cr%3Dthis%7D%7Dfunction%20nt(t%2Ce%2Cn%2Cs%2Cr%2Ci)%7Bconst%7BX%3Ac%2CY%3Aa%2Cpending%3Ah%7D%3Dt%2Cf%3De.length-r%3Blet%20l%3Bfor(h.length%26%26(e%3Dot(h%2Ce)%2Cn%3D((t%2Ce)%3D%3E%7Bif(e%26%26e%3Et.length)%7Bconst%20n%3Dt%3B(t%3Dnew%20o(e)).set(n%2C0)%7Dreturn%20t%7D)(n%2Cf-f%25W))%2Cl%3D0%3Bf-W%3E%3Dl%3Bl%2B%3DW)%7Bconst%20t%3Dat(G%2Cit(e%2Cl%2Cl%2BW))%3Bi%26%26a.update(t)%3Bconst%20r%3Dc.update(t)%3Bi%7C%7Ca.update(r)%2Cn.set(ct(G%2Cr)%2Cl%2Bs)%7Dreturn%20t.pending%3Dit(e%2Cl)%2Cn%7Dasync%20function%20st(n%2Cs%2Cr%2Ci)%7Bn.password%3Dnull%3Bconst%20c%3Dawait(async(t%2Ce%2Cn%2Cs%2Cr)%3D%3E%7Bif(!Y)return%20U.importKey(e)%3Btry%7Breturn%20await%20N.importKey(%22raw%22%2Ce%2Cn%2C!1%2Cr)%7Dcatch%7Breturn%20Y%3D!1%2CU.importKey(e)%7D%7D)(0%2Cr%2CE%2C0%2CO)%2Ca%3Dawait(async(t%2Ce%2Cn)%3D%3E%7Bif(!%24)return%20U._(e%2Ct.salt%2CL.iterations%2Cn)%3Btry%7Breturn%20await%20N.deriveBits(t%2Ce%2Cn)%7Dcatch%7Breturn%20%24%3D!1%2CU._(e%2Ct.salt%2CL.iterations%2Cn)%7D%7D)(e.assign(%7Bsalt%3Ai%7D%2CL)%2Cc%2C8*(2*j%5Bs%5D%2B2))%2Ch%3Dnew%20o(a)%2Cf%3Dat(G%2Cit(h%2C0%2Cj%5Bs%5D))%2Cl%3Dat(G%2Cit(h%2Cj%5Bs%5D%2C2*j%5Bs%5D))%2Cu%3Dit(h%2C2*j%5Bs%5D)%3Breturn%20e.assign(n%2C%7Bkeys%3A%7Bkey%3Af%2C%24%3Al%2CpasswordVerification%3Au%7D%2CX%3Anew%20Q(new%20J(f)%2Ct.from(Z))%2CY%3Anew%20X(l)%7D)%2Cu%7Dfunction%20rt(t%2Ce)%7Breturn%20e%3D%3D%3Db%3F(t%3D%3E%7Bif(typeof%20u%3D%3Dv)%7Bconst%20e%3Dnew%20o((t%3Dunescape(encodeURIComponent(t))).length)%3Bfor(let%20n%3D0%3Bn%3Ce.length%3Bn%2B%2B)e%5Bn%5D%3Dt.charCodeAt(n)%3Breturn%20e%7Dreturn(new%20u).encode(t)%7D)(t)%3Ae%7Dfunction%20ot(t%2Ce)%7Blet%20n%3Dt%3Breturn%20t.length%2Be.length%26%26(n%3Dnew%20o(t.length%2Be.length)%2Cn.set(t%2C0)%2Cn.set(e%2Ct.length))%2Cn%7Dfunction%20it(t%2Ce%2Cn)%7Breturn%20t.subarray(e%2Cn)%7Dfunction%20ct(t%2Ce)%7Breturn%20t.p(e)%7Dfunction%20at(t%2Ce)%7Breturn%20t.m(e)%7Dclass%20ht%20extends%20d%7Bconstructor(%7Bpassword%3At%2CpasswordVerification%3An%2CcheckPasswordOnly%3As%7D)%7Bsuper(%7Bstart()%7Be.assign(this%2C%7Bpassword%3At%2CpasswordVerification%3An%7D)%2Cwt(this%2Ct)%7D%2Ctransform(t%2Ce)%7Bconst%20n%3Dthis%3Bif(n.password)%7Bconst%20e%3Dlt(n%2Ct.subarray(0%2C12))%3Bif(n.password%3Dnull%2Ce.at(-1)!%3Dn.passwordVerification)throw%20new%20r(M)%3Bt%3Dt.subarray(12)%7Ds%3Fe.error(new%20r(B))%3Ae.enqueue(lt(n%2Ct))%7D%7D)%7D%7Dclass%20ft%20extends%20d%7Bconstructor(%7Bpassword%3At%2CpasswordVerification%3An%7D)%7Bsuper(%7Bstart()%7Be.assign(this%2C%7Bpassword%3At%2CpasswordVerification%3An%7D)%2Cwt(this%2Ct)%7D%2Ctransform(t%2Ce)%7Bconst%20n%3Dthis%3Blet%20s%2Cr%3Bif(n.password)%7Bn.password%3Dnull%3Bconst%20e%3DD(new%20o(12))%3Be%5B11%5D%3Dn.passwordVerification%2Cs%3Dnew%20o(t.length%2Be.length)%2Cs.set(ut(n%2Ce)%2C0)%2Cr%3D12%7Delse%20s%3Dnew%20o(t.length)%2Cr%3D0%3Bs.set(ut(n%2Ct)%2Cr)%2Ce.enqueue(s)%7D%7D)%7D%7Dfunction%20lt(t%2Ce)%7Bconst%20n%3Dnew%20o(e.length)%3Bfor(let%20s%3D0%3Bs%3Ce.length%3Bs%2B%2B)n%5Bs%5D%3Ddt(t)%5Ee%5Bs%5D%2Cpt(t%2Cn%5Bs%5D)%3Breturn%20n%7Dfunction%20ut(t%2Ce)%7Bconst%20n%3Dnew%20o(e.length)%3Bfor(let%20s%3D0%3Bs%3Ce.length%3Bs%2B%2B)n%5Bs%5D%3Ddt(t)%5Ee%5Bs%5D%2Cpt(t%2Ce%5Bs%5D)%3Breturn%20n%7Dfunction%20wt(t%2Cn)%7Bconst%20s%3D%5B305419896%2C591751049%2C878082192%5D%3Be.assign(t%2C%7Bkeys%3As%2Ctt%3Anew%20C(s%5B0%5D)%2Cet%3Anew%20C(s%5B2%5D)%7D)%3Bfor(let%20e%3D0%3Be%3Cn.length%3Be%2B%2B)pt(t%2Cn.charCodeAt(e))%7Dfunction%20pt(t%2Ce)%7Blet%5Bn%2Cr%2Co%5D%3Dt.keys%3Bt.tt.append(%5Be%5D)%2Cn%3D~t.tt.get()%2Cr%3Dmt(s.imul(mt(r%2Byt(n))%2C134775813)%2B1)%2Ct.et.append(%5Br%3E%3E%3E24%5D)%2Co%3D~t.et.get()%2Ct.keys%3D%5Bn%2Cr%2Co%5D%7Dfunction%20dt(t)%7Bconst%20e%3D2%7Ct.keys%5B2%5D%3Breturn%20yt(s.imul(e%2C1%5Ee)%3E%3E%3E8)%7Dfunction%20yt(t)%7Breturn%20255%26t%7Dfunction%20mt(t)%7Breturn%204294967295%26t%7Dclass%20gt%20extends%20d%7Bconstructor(t%2C%7BchunkSize%3Ae%2Cnt%3An%2CCompressionStream%3As%7D)%7Bsuper(%7B%7D)%3Bconst%7Bcompressed%3Ar%2Cencrypted%3Ao%2CuseCompressionStream%3Ai%2CzipCrypto%3Ac%2Csigned%3Aa%2Clevel%3Ah%7D%3Dt%2Cl%3Dthis%3Blet%20u%2Cw%2Cp%3Dsuper.readable%3Bo%26%26!c%7C%7C!a%7C%7C(u%3Dnew%20A%2Cp%3Dkt(p%2Cu))%2Cr%26%26(p%3Dvt(p%2Ci%2C%7Blevel%3Ah%2CchunkSize%3Ae%7D%2Cs%2Cn%2Cs))%2Co%26%26(c%3Fp%3Dkt(p%2Cnew%20ft(t))%3A(w%3Dnew%20et(t)%2Cp%3Dkt(p%2Cw)))%2Cbt(l%2Cp%2C()%3D%3E%7Blet%20t%3Bo%26%26!c%26%26(t%3Dw.signature)%2Co%26%26!c%7C%7C!a%7C%7C(t%3Dnew%20f(u.value.buffer).getUint32(0))%2Cl.signature%3Dt%7D)%7D%7Dclass%20St%20extends%20d%7Bconstructor(t%2C%7BchunkSize%3Ae%2Cst%3An%2CDecompressionStream%3As%7D)%7Bsuper(%7B%7D)%3Bconst%7BzipCrypto%3Ao%2Cencrypted%3Ai%2Csigned%3Ac%2Csignature%3Aa%2Ccompressed%3Ah%2CuseCompressionStream%3Al%2Crt%3Au%7D%3Dt%3Blet%20w%2Cp%2Cd%3Dsuper.readable%3Bi%26%26(o%3Fd%3Dkt(d%2Cnew%20ht(t))%3A(p%3Dnew%20tt(t)%2Cd%3Dkt(d%2Cp)))%2Ch%26%26(d%3Dvt(d%2Cl%2C%7BchunkSize%3Ae%2Crt%3Au%7D%2Cs%2Cn%2Cs))%2Ci%26%26!o%7C%7C!c%7C%7C(w%3Dnew%20A%2Cd%3Dkt(d%2Cw))%2Cbt(this%2Cd%2C()%3D%3E%7Bif((!i%7C%7Co)%26%26c)%7Bconst%20t%3Dnew%20f(w.value.buffer)%3Bif(a!%3Dt.getUint32(0%2C!1))throw%20new%20r(_)%7D%7D)%7D%7Dfunction%20bt(t%2Cn%2Cs)%7Bn%3Dkt(n%2Cnew%20d(%7Bflush%3As%7D))%2Ce.defineProperty(t%2C%22readable%22%2C%7Bget%3A()%3D%3En%7D)%7Dfunction%20vt(t%2Ce%2Cn%2Cs%2Cr%2Co)%7Bconst%20i%3De%26%26s%3Fs%3Ar%7C%7Co%2Cc%3Dn.rt%3F%22deflate64-raw%22%3A%22deflate-raw%22%3Btry%7Bt%3Dkt(t%2Cnew%20i(c%2Cn))%7Dcatch(s)%7Bif(!e)throw%20s%3Bif(r)t%3Dkt(t%2Cnew%20r(c%2Cn))%3Belse%7Bif(!o)throw%20s%3Bt%3Dkt(t%2Cnew%20o(c%2Cn))%7D%7Dreturn%20t%7Dfunction%20kt(t%2Ce)%7Breturn%20t.pipeThrough(e)%7Dconst%20zt%3D%22data%22%2CCt%3D%22close%22%3Bclass%20At%20extends%20d%7Bconstructor(t%2Cn)%7Bsuper(%7B%7D)%3Bconst%20s%3Dthis%2C%7BcodecType%3Ao%7D%3Dt%3Blet%20i%3Bo.startsWith(%22deflate%22)%3Fi%3Dgt%3Ao.startsWith(%22inflate%22)%26%26(i%3DSt)%2Cs.outputSize%3D0%3Blet%20c%3D0%3Bconst%20a%3Dnew%20i(t%2Cn)%2Ch%3Dsuper.readable%2Cf%3Dnew%20d(%7Btransform(t%2Ce)%7Bt%26%26t.length%26%26(c%2B%3Dt.length%2Ce.enqueue(t))%7D%2Cflush()%7Be.assign(s%2C%7BinputSize%3Ac%7D)%7D%7D)%2Cl%3Dnew%20d(%7Btransform(e%2Cn)%7Bif(e%26%26e.length%26%26(n.enqueue(e)%2Cs.outputSize%2B%3De.length%2Ct.outputSize!%3D%3Db%26%26s.outputSize%3Et.outputSize))throw%20new%20r(%22Invalid%20uncompressed%20size%22)%7D%2Cflush()%7Bconst%7Bsignature%3At%7D%3Da%3Be.assign(s%2C%7Bsignature%3At%2CinputSize%3Ac%7D)%7D%7D)%3Be.defineProperty(s%2C%22readable%22%2C%7Bget%3A()%3D%3Eh.pipeThrough(f).pipeThrough(a).pipeThrough(l)%7D)%7D%7Dclass%20xt%20extends%20d%7Bconstructor(t)%7Blet%20e%3Bsuper(%7Btransform%3Afunction%20n(s%2Cr)%7Bif(e)%7Bconst%20t%3Dnew%20o(e.length%2Bs.length)%3Bt.set(e)%2Ct.set(s%2Ce.length)%2Cs%3Dt%2Ce%3Dnull%7Ds.length%3Et%3F(r.enqueue(s.slice(0%2Ct))%2Cn(s.slice(t)%2Cr))%3Ae%3Ds%7D%2Cflush(t)%7Be%26%26e.length%26%26t.enqueue(e)%7D%7D)%7D%7Dconst%20It%3Dnew%20h%2CRt%3Dnew%20h%3Blet%20Pt%2CUt%2CVt%2CMt%2C_t%2CBt%3D0%3Basync%20function%20Dt(t)%7Btry%7Bconst%7Boptions%3Ae%2Cconfig%3As%7D%3Dt%3Bif(!e.useCompressionStream)try%7Bawait%20self.initModule(t.config)%7Dcatch%7Be.useCompressionStream%3D!0%7Ds.CompressionStream%3Dself.CompressionStream%2Cs.DecompressionStream%3Dself.DecompressionStream%3Bconst%20r%3D%7BhighWaterMark%3A1%7D%2Co%3Dt.readable%7C%7Cnew%20y(%7Basync%20pull(t)%7Bconst%20e%3Dnew%20l(t%3D%3EIt.set(Bt%2Ct))%3BWt(%7Btype%3A%22pull%22%2CmessageId%3ABt%7D)%2CBt%3D(Bt%2B1)%25n.MAX_SAFE_INTEGER%3Bconst%7Bvalue%3As%2Cdone%3Ar%7D%3Dawait%20e%3Bt.enqueue(s)%2Cr%26%26t.close()%7D%7D%2Cr)%2Ci%3Dt.writable%7C%7Cnew%20m(%7Basync%20write(t)%7Blet%20e%3Bconst%20s%3Dnew%20l(t%3D%3Ee%3Dt)%3BRt.set(Bt%2Ce)%2CWt(%7Btype%3Azt%2Cvalue%3At%2CmessageId%3ABt%7D)%2CBt%3D(Bt%2B1)%25n.MAX_SAFE_INTEGER%2Cawait%20s%7D%7D%2Cr)%2Cc%3Dnew%20At(e%2Cs)%3BPt%3Dnew%20AbortController%3Bconst%7Bsignal%3Aa%7D%3DPt%3Bawait%20o.pipeThrough(c).pipeThrough(new%20xt(s.chunkSize)).pipeTo(i%2C%7Bsignal%3Aa%2CpreventClose%3A!0%2CpreventAbort%3A!0%7D)%2Cawait%20i.getWriter().close()%3Bconst%7Bsignature%3Ah%2CinputSize%3Af%2CoutputSize%3Au%7D%3Dc%3BWt(%7Btype%3ACt%2Cresult%3A%7Bsignature%3Ah%2CinputSize%3Af%2CoutputSize%3Au%7D%7D)%7Dcatch(t)%7Bt.outputSize%3D0%2CKt(t)%7D%7Dfunction%20Wt(t)%7Blet%7Bvalue%3Ae%7D%3Dt%3Bif(e)if(e.length)try%7Be%3Dnew%20o(e)%2Ct.value%3De.buffer%2Cp(t%2C%5Bt.value%5D)%7Dcatch%7Bp(t)%7Delse%20p(t)%3Belse%20p(t)%7Dfunction%20Kt(t%3Dnew%20r(%22Unknown%20error%22))%7Bconst%7Bmessage%3Ae%2Cstack%3An%2Ccode%3As%2Cname%3Ao%2CoutputSize%3Ai%7D%3Dt%3Bp(%7Berror%3A%7Bmessage%3Ae%2Cstack%3An%2Ccode%3As%2Cname%3Ao%2CoutputSize%3Ai%7D%7D)%7Dfunction%20Et(t%2Ce%2Cn%3D%7B%7D)%7Bconst%20i%3D%22number%22%3D%3Dtypeof%20n.level%3Fn.level%3A-1%2Cc%3D%22number%22%3D%3Dtypeof%20n.ot%3Fn.ot%3A65536%2Ca%3D%22number%22%3D%3Dtypeof%20n.it%3Fn.it%3A65536%3Breturn%20new%20d(%7Bstart()%7Blet%20n%3Bif(this.ct%3DVt(c)%2Cthis.in%3DVt(a)%2Cthis.it%3Da%2Cthis.ht%3Dnew%20o(c)%2Ct%3F(this.ft%3DUt.deflate_process%2Cthis.lt%3DUt.deflate_last_consumed%2Cthis.ut%3DUt.deflate_end%2Cthis.wt%3DUt.deflate_new()%2Cn%3D%22gzip%22%3D%3D%3De%3FUt.deflate_init_gzip(this.wt%2Ci)%3A%22deflate-raw%22%3D%3D%3De%3FUt.deflate_init_raw(this.wt%2Ci)%3AUt.deflate_init(this.wt%2Ci))%3A%22deflate64-raw%22%3D%3D%3De%3F(this.ft%3DUt.inflate9_process%2Cthis.lt%3DUt.inflate9_last_consumed%2Cthis.ut%3DUt.inflate9_end%2Cthis.wt%3DUt.inflate9_new()%2Cn%3DUt.inflate9_init_raw(this.wt))%3A(this.ft%3DUt.inflate_process%2Cthis.lt%3DUt.inflate_last_consumed%2Cthis.ut%3DUt.inflate_end%2Cthis.wt%3DUt.inflate_new()%2Cn%3D%22deflate-raw%22%3D%3D%3De%3FUt.inflate_init_raw(this.wt)%3A%22gzip%22%3D%3D%3De%3FUt.inflate_init_gzip(this.wt)%3AUt.inflate_init(this.wt))%2C0!%3D%3Dn)throw%20new%20r(%22init%20failed%3A%22%2Bn)%7D%2Ctransform(e%2Cn)%7Btry%7Bconst%20i%3De%2Ca%3Dnew%20o(_t.buffer)%2Ch%3Dthis.ft%2Cf%3Dthis.lt%2Cl%3Dthis.ct%2Cu%3Dthis.ht%3Blet%20w%3D0%3Bfor(%3Bw%3Ci.length%3B)%7Bconst%20e%3Ds.min(i.length-w%2C32768)%3Bthis.in%26%26this.it%3E%3De%7C%7C(this.in%26%26Mt%26%26Mt(this.in)%2Cthis.in%3DVt(e)%2Cthis.it%3De)%2Ca.set(i.subarray(w%2Cw%2Be)%2Cthis.in)%3Bconst%20o%3Dh(this.wt%2Cthis.in%2Ce%2Cl%2Cc%2C0)%2Cp%3D16777215%26o%3Bif(p%26%26(u.set(a.subarray(l%2Cl%2Bp)%2C0)%2Cn.enqueue(u.slice(0%2Cp)))%2C!t)%7Bconst%20t%3Do%3E%3E24%26255%2Ce%3D128%26t%3Ft-256%3At%3Bif(0%3Ee)throw%20new%20r(%22process%20error%3A%22%2Be)%7Dconst%20d%3Df(this.wt)%3Bif(0%3D%3D%3Dd)break%3Bw%2B%3Dd%7D%7Dcatch(t)%7Bthis.ut%26%26this.wt%26%26this.ut(this.wt)%2Cthis.in%26%26Mt%26%26Mt(this.in)%2Cthis.ct%26%26Mt%26%26Mt(this.ct)%2Cn.error(t)%7D%7D%2Cflush(e)%7Btry%7Bconst%20n%3Dnew%20o(_t.buffer)%2Cs%3Dthis.ft%2Ci%3Dthis.ct%2Ca%3Dthis.ht%3Bfor(%3B%3B)%7Bconst%20o%3Ds(this.wt%2C0%2C0%2Ci%2Cc%2C4)%2Ch%3D16777215%26o%2Cf%3Do%3E%3E24%26255%3Bif(!t)%7Bconst%20t%3D128%26f%3Ff-256%3Af%3Bif(0%3Et)throw%20new%20r(%22process%20error%3A%22%2Bt)%7Dif(h%26%26(a.set(n.subarray(i%2Ci%2Bh)%2C0)%2Ce.enqueue(a.slice(0%2Ch)))%2C1%3D%3D%3Df%7C%7C0%3D%3D%3Dh)break%7D%7Dcatch(t)%7Be.error(t)%7Dfinally%7Bif(this.ut%26%26this.wt)%7Bconst%20t%3Dthis.ut(this.wt)%3B0!%3D%3Dt%26%26e.error(new%20r(%22end%20error%3A%22%2Bt))%7Dthis.in%26%26Mt%26%26Mt(this.in)%2Cthis.ct%26%26Mt%26%26Mt(this.ct)%7D%7D%7D)%7DaddEventListener(%22message%22%2C(%7Bdata%3At%7D)%3D%3E%7Bconst%7Btype%3Ae%2CmessageId%3An%2Cvalue%3As%2Cdone%3Ar%7D%3Dt%3Btry%7Bif(%22start%22%3D%3De%26%26Dt(t)%2Ce%3D%3Dzt)%7Bconst%20t%3DIt.get(n)%3BIt.delete(n)%2Ct(%7Bvalue%3Anew%20o(s)%2Cdone%3Ar%7D)%7Dif(%22ack%22%3D%3De)%7Bconst%20t%3DRt.get(n)%3BRt.delete(n)%2Ct()%7De%3D%3DCt%26%26Pt.abort()%7Dcatch(t)%7BKt(t)%7D%7D)%3Bclass%20Lt%7Bconstructor(t%3D%22deflate%22%2Ce)%7Breturn%20Et(!0%2Ct%2Ce)%7D%7Dclass%20Ot%7Bconstructor(t%3D%22deflate%22%2Ce)%7Breturn%20Et(!1%2Ct%2Ce)%7D%7Dlet%20Tt%3D!1%3Bself.initModule%3Dasync%20t%3D%3E%7Btry%7Bconst%20e%3Dawait(async(t%2C%7BbaseURI%3Ae%7D)%3D%3E%7Bif(!Tt)%7Blet%20n%2Cs%3Btry%7Btry%7Bs%3Dnew%20URL(t%2Ce)%7Dcatch%7B%7Dconst%20r%3Dawait%20fetch(s)%3Bn%3Dawait%20r.arrayBuffer()%7Dcatch(e)%7Bif(!t.startsWith(%22data%3Aapplication%2Fwasm%3Bbase64%2C%22))throw%20e%3Bn%3D(t%3D%3E%7Bconst%20e%3Dt.split(%22%2C%22)%5B1%5D%2Cn%3Datob(e)%2Cs%3Dn.length%2Cr%3Dnew%20o(s)%3Bfor(let%20t%3D0%3Bs%3Et%3B%2B%2Bt)r%5Bt%5D%3Dn.charCodeAt(t)%3Breturn%20r.buffer%7D)(t)%7D(t%3D%3E%7Bif(Ut%3Dt%2C(%7Bmalloc%3AVt%2Cfree%3AMt%2Cmemory%3A_t%7D%3DUt)%2C%22function%22!%3Dtypeof%20Vt%7C%7C%22function%22!%3Dtypeof%20Mt%7C%7C!_t)throw%20Ut%3DVt%3DMt%3D_t%3Dnull%2Cnew%20r(%22Invalid%20WASM%20module%22)%7D)((await%20WebAssembly.instantiate(n)).instance.exports)%2CTt%3D!0%7D%7D)(t.wasmURI%2Ct)%3Breturn%20t.nt%3DLt%2Ct.st%3DOt%2Ce%7Dcatch%7B%7D%7D%7D)%3B%0A";
	} });
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/codecs/crc32.js
const table$1 = [];
for (let i = 0; i < 256; i++) {
	let t = i;
	for (let j = 0; j < 8; j++) if (t & 1) t = t >>> 1 ^ 3988292384;
	else t = t >>> 1;
	table$1[i] = t;
}
var Crc32 = class {
	constructor(crc) {
		this.crc = crc || -1;
	}
	append(data) {
		let crc = this.crc | 0;
		for (let offset = 0, length = data.length | 0; offset < length; offset++) crc = crc >>> 8 ^ table$1[(crc ^ data[offset]) & 255];
		this.crc = crc;
	}
	get() {
		return ~this.crc;
	}
};
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/crc32-stream.js
var Crc32Stream = class extends TransformStream {
	constructor() {
		let stream;
		const crc32 = new Crc32();
		super({
			transform(chunk, controller) {
				crc32.append(chunk);
				controller.enqueue(chunk);
			},
			flush() {
				const value = new Uint8Array(4);
				new DataView(value.buffer).setUint32(0, crc32.get());
				stream.value = value;
			}
		});
		stream = this;
	}
};
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/util/encode-text.js
function encodeText(value) {
	if (typeof TextEncoder == "undefined") {
		value = unescape(encodeURIComponent(value));
		const result = new Uint8Array(value.length);
		for (let i = 0; i < result.length; i++) result[i] = value.charCodeAt(i);
		return result;
	} else return new TextEncoder().encode(value);
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/codecs/sjcl.js
/** @fileOverview Javascript cryptography implementation.
*
* Crush to remove comments, shorten variable names and
* generally reduce transmission size.
*
* @author Emily Stark
* @author Mike Hamburg
* @author Dan Boneh
*/
/** @fileOverview Arrays of bits, encoded as arrays of Numbers.
*
* @author Emily Stark
* @author Mike Hamburg
* @author Dan Boneh
*/
/**
* Arrays of bits, encoded as arrays of Numbers.
* @namespace
* @description
* <p>
* These objects are the currency accepted by SJCL's crypto functions.
* </p>
*
* <p>
* Most of our crypto primitives operate on arrays of 4-byte words internally,
* but many of them can take arguments that are not a multiple of 4 bytes.
* This library encodes arrays of bits (whose size need not be a multiple of 8
* bits) as arrays of 32-bit words.  The bits are packed, big-endian, into an
* array of words, 32 bits at a time.  Since the words are double-precision
* floating point numbers, they fit some extra data.  We use this (in a private,
* possibly-changing manner) to encode the number of bits actually  present
* in the last word of the array.
* </p>
*
* <p>
* Because bitwise ops clear this out-of-band data, these arrays can be passed
* to ciphers like AES which want arrays of words.
* </p>
*/
const bitArray = {
	concat(a1, a2) {
		if (a1.length === 0 || a2.length === 0) return a1.concat(a2);
		const last = a1[a1.length - 1], shift = bitArray.getPartial(last);
		if (shift === 32) return a1.concat(a2);
		else return bitArray._shiftRight(a2, shift, last | 0, a1.slice(0, a1.length - 1));
	},
	bitLength(a) {
		const l = a.length;
		if (l === 0) return 0;
		const x = a[l - 1];
		return (l - 1) * 32 + bitArray.getPartial(x);
	},
	clamp(a, len) {
		if (a.length * 32 < len) return a;
		a = a.slice(0, Math.ceil(len / 32));
		const l = a.length;
		len = len & 31;
		if (l > 0 && len) a[l - 1] = bitArray.partial(len, a[l - 1] & 2147483648 >> len - 1, 1);
		return a;
	},
	partial(len, x, _end) {
		if (len === 32) return x;
		return (_end ? x | 0 : x << 32 - len) + len * 1099511627776;
	},
	getPartial(x) {
		return Math.round(x / 1099511627776) || 32;
	},
	_shiftRight(a, shift, carry, out) {
		if (out === void 0) out = [];
		for (; shift >= 32; shift -= 32) {
			out.push(carry);
			carry = 0;
		}
		if (shift === 0) return out.concat(a);
		for (let i = 0; i < a.length; i++) {
			out.push(carry | a[i] >>> shift);
			carry = a[i] << 32 - shift;
		}
		const last2 = a.length ? a[a.length - 1] : 0;
		const shift2 = bitArray.getPartial(last2);
		out.push(bitArray.partial(shift + shift2 & 31, shift + shift2 > 32 ? carry : out.pop(), 1));
		return out;
	}
};
/** @fileOverview Bit array codec implementations.
*
* @author Emily Stark
* @author Mike Hamburg
* @author Dan Boneh
*/
/**
* Arrays of bytes
* @namespace
*/
const codec = { bytes: {
	fromBits(arr) {
		const byteLength = bitArray.bitLength(arr) / 8;
		const out = new Uint8Array(byteLength);
		let tmp;
		for (let i = 0; i < byteLength; i++) {
			if ((i & 3) === 0) tmp = arr[i / 4];
			out[i] = tmp >>> 24;
			tmp <<= 8;
		}
		return out;
	},
	toBits(bytes) {
		const out = [];
		let i;
		let tmp = 0;
		for (i = 0; i < bytes.length; i++) {
			tmp = tmp << 8 | bytes[i];
			if ((i & 3) === 3) {
				out.push(tmp);
				tmp = 0;
			}
		}
		if (i & 3) out.push(bitArray.partial(8 * (i & 3), tmp));
		return out;
	}
} };
const hash = {};
/**
* Context for a SHA-1 operation in progress.
* @constructor
*/
hash.sha1 = class {
	constructor(hash) {
		const sha1 = this;
		/**
		* The hash's block size, in bits.
		* @constant
		*/
		sha1.blockSize = 512;
		/**
		* The SHA-1 initialization vector.
		* @private
		*/
		sha1._init = [
			1732584193,
			4023233417,
			2562383102,
			271733878,
			3285377520
		];
		/**
		* The SHA-1 hash key.
		* @private
		*/
		sha1._key = [
			1518500249,
			1859775393,
			2400959708,
			3395469782
		];
		if (hash) {
			sha1._h = hash._h.slice(0);
			sha1._buffer = hash._buffer.slice(0);
			sha1._length = hash._length;
		} else sha1.reset();
	}
	/**
	* Reset the hash state.
	* @return this
	*/
	reset() {
		const sha1 = this;
		sha1._h = sha1._init.slice(0);
		sha1._buffer = [];
		sha1._length = 0;
		return sha1;
	}
	/**
	* Input several words to the hash.
	* @param {bitArray|String} data the data to hash.
	* @return this
	*/
	update(data) {
		const sha1 = this;
		if (typeof data === "string") data = codec.utf8String.toBits(data);
		const b = sha1._buffer = bitArray.concat(sha1._buffer, data);
		const ol = sha1._length;
		const nl = sha1._length = ol + bitArray.bitLength(data);
		if (nl > 9007199254740991) throw new Error("Cannot hash more than 2^53 - 1 bits");
		const c = new Uint32Array(b);
		let j = 0;
		for (let i = sha1.blockSize + ol - (sha1.blockSize + ol & sha1.blockSize - 1); i <= nl; i += sha1.blockSize) {
			sha1._block(c.subarray(16 * j, 16 * (j + 1)));
			j += 1;
		}
		b.splice(0, 16 * j);
		return sha1;
	}
	/**
	* Complete hashing and output the hash value.
	* @return {bitArray} The hash value, an array of 5 big-endian words. TODO
	*/
	finalize() {
		const sha1 = this;
		let b = sha1._buffer;
		const h = sha1._h;
		b = bitArray.concat(b, [bitArray.partial(1, 1)]);
		for (let i = b.length + 2; i & 15; i++) b.push(0);
		b.push(Math.floor(sha1._length / 4294967296));
		b.push(sha1._length | 0);
		while (b.length) sha1._block(b.splice(0, 16));
		sha1.reset();
		return h;
	}
	/**
	* The SHA-1 logical functions f(0), f(1), ..., f(79).
	* @private
	*/
	_f(t, b, c, d) {
		if (t <= 19) return b & c | ~b & d;
		else if (t <= 39) return b ^ c ^ d;
		else if (t <= 59) return b & c | b & d | c & d;
		else if (t <= 79) return b ^ c ^ d;
	}
	/**
	* Circular left-shift operator.
	* @private
	*/
	_S(n, x) {
		return x << n | x >>> 32 - n;
	}
	/**
	* Perform one cycle of SHA-1.
	* @param {Uint32Array|bitArray} words one block of words.
	* @private
	*/
	_block(words) {
		const sha1 = this;
		const h = sha1._h;
		const w = Array(80);
		for (let j = 0; j < 16; j++) w[j] = words[j];
		let a = h[0];
		let b = h[1];
		let c = h[2];
		let d = h[3];
		let e = h[4];
		for (let t = 0; t <= 79; t++) {
			if (t >= 16) w[t] = sha1._S(1, w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]);
			const tmp = sha1._S(5, a) + sha1._f(t, b, c, d) + e + w[t] + sha1._key[Math.floor(t / 20)] | 0;
			e = d;
			d = c;
			c = sha1._S(30, b);
			b = a;
			a = tmp;
		}
		h[0] = h[0] + a | 0;
		h[1] = h[1] + b | 0;
		h[2] = h[2] + c | 0;
		h[3] = h[3] + d | 0;
		h[4] = h[4] + e | 0;
	}
};
/** @fileOverview Low-level AES implementation.
*
* This file contains a low-level implementation of AES, optimized for
* size and for efficiency on several browsers.  It is based on
* OpenSSL's aes_core.c, a public-domain implementation by Vincent
* Rijmen, Antoon Bosselaers and Paulo Barreto.
*
* An older version of this implementation is available in the public
* domain, but this one is (c) Emily Stark, Mike Hamburg, Dan Boneh,
* Stanford University 2008-2010 and BSD-licensed for liability
* reasons.
*
* @author Emily Stark
* @author Mike Hamburg
* @author Dan Boneh
*/
const cipher = {};
/**
* Schedule out an AES key for both encryption and decryption.  This
* is a low-level class.  Use a cipher mode to do bulk encryption.
*
* @constructor
* @param {Array} key The key as an array of 4, 6 or 8 words.
*/
cipher.aes = class {
	constructor(key) {
		/**
		* The expanded S-box and inverse S-box tables.  These will be computed
		* on the client so that we don't have to send them down the wire.
		*
		* There are two tables, _tables[0] is for encryption and
		* _tables[1] is for decryption.
		*
		* The first 4 sub-tables are the expanded S-box with MixColumns.  The
		* last (_tables[01][4]) is the S-box itself.
		*
		* @private
		*/
		const aes = this;
		aes._tables = [[
			[],
			[],
			[],
			[],
			[]
		], [
			[],
			[],
			[],
			[],
			[]
		]];
		if (!aes._tables[0][0][0]) aes._precompute();
		const sbox = aes._tables[0][4];
		const decTable = aes._tables[1];
		const keyLen = key.length;
		let i, encKey, decKey, rcon = 1;
		if (keyLen !== 4 && keyLen !== 6 && keyLen !== 8) throw new Error("invalid aes key size");
		aes._key = [encKey = key.slice(0), decKey = []];
		for (i = keyLen; i < 4 * keyLen + 28; i++) {
			let tmp = encKey[i - 1];
			if (i % keyLen === 0 || keyLen === 8 && i % keyLen === 4) {
				tmp = sbox[tmp >>> 24] << 24 ^ sbox[tmp >> 16 & 255] << 16 ^ sbox[tmp >> 8 & 255] << 8 ^ sbox[tmp & 255];
				if (i % keyLen === 0) {
					tmp = tmp << 8 ^ tmp >>> 24 ^ rcon << 24;
					rcon = rcon << 1 ^ (rcon >> 7) * 283;
				}
			}
			encKey[i] = encKey[i - keyLen] ^ tmp;
		}
		for (let j = 0; i; j++, i--) {
			const tmp = encKey[j & 3 ? i : i - 4];
			if (i <= 4 || j < 4) decKey[j] = tmp;
			else decKey[j] = decTable[0][sbox[tmp >>> 24]] ^ decTable[1][sbox[tmp >> 16 & 255]] ^ decTable[2][sbox[tmp >> 8 & 255]] ^ decTable[3][sbox[tmp & 255]];
		}
	}
	/**
	* Encrypt an array of 4 big-endian words.
	* @param {Array} data The plaintext.
	* @return {Array} The ciphertext.
	*/
	encrypt(data) {
		return this._crypt(data, 0);
	}
	/**
	* Decrypt an array of 4 big-endian words.
	* @param {Array} data The ciphertext.
	* @return {Array} The plaintext.
	*/
	decrypt(data) {
		return this._crypt(data, 1);
	}
	/**
	* Expand the S-box tables.
	*
	* @private
	*/
	_precompute() {
		const encTable = this._tables[0];
		const decTable = this._tables[1];
		const sbox = encTable[4];
		const sboxInv = decTable[4];
		const d = [];
		const th = [];
		let xInv, x2, x4, x8;
		for (let i = 0; i < 256; i++) th[(d[i] = i << 1 ^ (i >> 7) * 283) ^ i] = i;
		for (let x = xInv = 0; !sbox[x]; x ^= x2 || 1, xInv = th[xInv] || 1) {
			let s = xInv ^ xInv << 1 ^ xInv << 2 ^ xInv << 3 ^ xInv << 4;
			s = s >> 8 ^ s & 255 ^ 99;
			sbox[x] = s;
			sboxInv[s] = x;
			x8 = d[x4 = d[x2 = d[x]]];
			let tDec = x8 * 16843009 ^ x4 * 65537 ^ x2 * 257 ^ x * 16843008;
			let tEnc = d[s] * 257 ^ s * 16843008;
			for (let i = 0; i < 4; i++) {
				encTable[i][x] = tEnc = tEnc << 24 ^ tEnc >>> 8;
				decTable[i][s] = tDec = tDec << 24 ^ tDec >>> 8;
			}
		}
		for (let i = 0; i < 5; i++) {
			encTable[i] = encTable[i].slice(0);
			decTable[i] = decTable[i].slice(0);
		}
	}
	/**
	* Encryption and decryption core.
	* @param {Array} input Four words to be encrypted or decrypted.
	* @param dir The direction, 0 for encrypt and 1 for decrypt.
	* @return {Array} The four encrypted or decrypted words.
	* @private
	*/
	_crypt(input, dir) {
		if (input.length !== 4) throw new Error("invalid aes block size");
		const key = this._key[dir];
		const nInnerRounds = key.length / 4 - 2;
		const out = [
			0,
			0,
			0,
			0
		];
		const table = this._tables[dir];
		const t0 = table[0];
		const t1 = table[1];
		const t2 = table[2];
		const t3 = table[3];
		const sbox = table[4];
		let a = input[0] ^ key[0];
		let b = input[dir ? 3 : 1] ^ key[1];
		let c = input[2] ^ key[2];
		let d = input[dir ? 1 : 3] ^ key[3];
		let kIndex = 4;
		let a2, b2, c2;
		for (let i = 0; i < nInnerRounds; i++) {
			a2 = t0[a >>> 24] ^ t1[b >> 16 & 255] ^ t2[c >> 8 & 255] ^ t3[d & 255] ^ key[kIndex];
			b2 = t0[b >>> 24] ^ t1[c >> 16 & 255] ^ t2[d >> 8 & 255] ^ t3[a & 255] ^ key[kIndex + 1];
			c2 = t0[c >>> 24] ^ t1[d >> 16 & 255] ^ t2[a >> 8 & 255] ^ t3[b & 255] ^ key[kIndex + 2];
			d = t0[d >>> 24] ^ t1[a >> 16 & 255] ^ t2[b >> 8 & 255] ^ t3[c & 255] ^ key[kIndex + 3];
			kIndex += 4;
			a = a2;
			b = b2;
			c = c2;
		}
		for (let i = 0; i < 4; i++) {
			out[dir ? 3 & -i : i] = sbox[a >>> 24] << 24 ^ sbox[b >> 16 & 255] << 16 ^ sbox[c >> 8 & 255] << 8 ^ sbox[d & 255] ^ key[kIndex++];
			a2 = a;
			a = b;
			b = c;
			c = d;
			d = a2;
		}
		return out;
	}
};
/**
* Random values
* @namespace
*/
const random = { getRandomValues(typedArray) {
	const words = new Uint32Array(typedArray.buffer);
	const r = (m_w) => {
		let m_z = 987654321;
		const mask = 4294967295;
		return function() {
			m_z = 36969 * (m_z & 65535) + (m_z >> 16) & mask;
			m_w = 18e3 * (m_w & 65535) + (m_w >> 16) & mask;
			return (((m_z << 16) + m_w & mask) / 4294967296 + .5) * (Math.random() > .5 ? 1 : -1);
		};
	};
	for (let i = 0, rcache; i < typedArray.length; i += 4) {
		const _r = r((rcache || Math.random()) * 4294967296);
		rcache = _r() * 987654071;
		words[i / 4] = _r() * 4294967296 | 0;
	}
	return typedArray;
} };
/** @fileOverview CTR mode implementation.
*
* Special thanks to Roy Nicholson for pointing out a bug in our
* implementation.
*
* @author Emily Stark
* @author Mike Hamburg
* @author Dan Boneh
*/
/** Brian Gladman's CTR Mode.
* @constructor
* @param {Object} _prf The aes instance to generate key.
* @param {bitArray} _iv The iv for ctr mode, it must be 128 bits.
*/
const mode = {};
/**
* Brian Gladman's CTR Mode.
* @namespace
*/
mode.ctrGladman = class {
	constructor(prf, iv) {
		this._prf = prf;
		this._initIv = iv;
		this._iv = iv;
	}
	reset() {
		this._iv = this._initIv;
	}
	/** Input some data to calculate.
	* @param {bitArray} data the data to process, it must be intergral multiple of 128 bits unless it's the last.
	*/
	update(data) {
		return this.calculate(this._prf, data, this._iv);
	}
	incWord(word) {
		if ((word >> 24 & 255) === 255) {
			let b1 = word >> 16 & 255;
			let b2 = word >> 8 & 255;
			let b3 = word & 255;
			if (b1 === 255) {
				b1 = 0;
				if (b2 === 255) {
					b2 = 0;
					if (b3 === 255) b3 = 0;
					else ++b3;
				} else ++b2;
			} else ++b1;
			word = 0;
			word += b1 << 16;
			word += b2 << 8;
			word += b3;
		} else word += 1 << 24;
		return word;
	}
	incCounter(counter) {
		if ((counter[0] = this.incWord(counter[0])) === 0) counter[1] = this.incWord(counter[1]);
	}
	calculate(prf, data, iv) {
		let l;
		if (!(l = data.length)) return [];
		const bl = bitArray.bitLength(data);
		for (let i = 0; i < l; i += 4) {
			this.incCounter(iv);
			const e = prf.encrypt(iv);
			data[i] ^= e[0];
			data[i + 1] ^= e[1];
			data[i + 2] ^= e[2];
			data[i + 3] ^= e[3];
		}
		return bitArray.clamp(data, bl);
	}
};
const misc = {
	importKey(password) {
		return new misc.hmacSha1(codec.bytes.toBits(password));
	},
	pbkdf2(prf, salt, count, length) {
		count = count || 1e4;
		if (length < 0 || count < 0) throw new Error("invalid params to pbkdf2");
		const byteLength = (length >> 5) + 1 << 2;
		let u, ui, i, j, k;
		const arrayBuffer = new ArrayBuffer(byteLength);
		const out = new DataView(arrayBuffer);
		let outLength = 0;
		const b = bitArray;
		salt = codec.bytes.toBits(salt);
		for (k = 1; outLength < (byteLength || 1); k++) {
			u = ui = prf.encrypt(b.concat(salt, [k]));
			for (i = 1; i < count; i++) {
				ui = prf.encrypt(ui);
				for (j = 0; j < ui.length; j++) u[j] ^= ui[j];
			}
			for (i = 0; outLength < (byteLength || 1) && i < u.length; i++) {
				out.setInt32(outLength, u[i]);
				outLength += 4;
			}
		}
		return arrayBuffer.slice(0, length / 8);
	}
};
/** @fileOverview HMAC implementation.
*
* @author Emily Stark
* @author Mike Hamburg
* @author Dan Boneh
*/
/** HMAC with the specified hash function.
* @constructor
* @param {bitArray} key the key for HMAC.
* @param {Object} [Hash=hash.sha1] The hash function to use.
*/
misc.hmacSha1 = class {
	constructor(key) {
		const hmac = this;
		const Hash = hmac._hash = hash.sha1;
		const exKey = [[], []];
		hmac._baseHash = [new Hash(), new Hash()];
		const bs = hmac._baseHash[0].blockSize / 32;
		if (key.length > bs) key = new Hash().update(key).finalize();
		for (let i = 0; i < bs; i++) {
			exKey[0][i] = key[i] ^ 909522486;
			exKey[1][i] = key[i] ^ 1549556828;
		}
		hmac._baseHash[0].update(exKey[0]);
		hmac._baseHash[1].update(exKey[1]);
		hmac._resultHash = new Hash(hmac._baseHash[0]);
	}
	reset() {
		const hmac = this;
		hmac._resultHash = new hmac._hash(hmac._baseHash[0]);
		hmac._updated = false;
	}
	update(data) {
		const hmac = this;
		hmac._updated = true;
		hmac._resultHash.update(data);
	}
	digest() {
		const hmac = this;
		const w = hmac._resultHash.finalize();
		const result = new hmac._hash(hmac._baseHash[1]).update(w).finalize();
		hmac.reset();
		return result;
	}
	encrypt(data) {
		if (!this._updated) {
			this.update(data);
			return this.digest(data);
		} else throw new Error("encrypt on already updated hmac called!");
	}
};
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/common-crypto.js
const GET_RANDOM_VALUES_SUPPORTED = typeof crypto != "undefined" && typeof crypto.getRandomValues == "function";
const ERR_INVALID_PASSWORD = "Invalid password";
const ERR_INVALID_SIGNATURE = "Invalid signature";
const ERR_ABORT_CHECK_PASSWORD = "zipjs-abort-check-password";
function getRandomValues(array) {
	if (GET_RANDOM_VALUES_SUPPORTED) return crypto.getRandomValues(array);
	else return random.getRandomValues(array);
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/aes-crypto-stream.js
const BLOCK_LENGTH = 16;
const RAW_FORMAT = "raw";
const PBKDF2_ALGORITHM = { name: "PBKDF2" };
const HASH_ALGORITHM = { name: "HMAC" };
const HASH_FUNCTION = "SHA-1";
const BASE_KEY_ALGORITHM = Object.assign({ hash: HASH_ALGORITHM }, PBKDF2_ALGORITHM);
const DERIVED_BITS_ALGORITHM = Object.assign({
	iterations: 1e3,
	hash: { name: HASH_FUNCTION }
}, PBKDF2_ALGORITHM);
const DERIVED_BITS_USAGE = ["deriveBits"];
const SALT_LENGTH = [
	8,
	12,
	16
];
const KEY_LENGTH = [
	16,
	24,
	32
];
const SIGNATURE_LENGTH = 10;
const COUNTER_DEFAULT_VALUE = [
	0,
	0,
	0,
	0
];
const CRYPTO_API_SUPPORTED = typeof crypto != UNDEFINED_TYPE;
const subtle = CRYPTO_API_SUPPORTED && crypto.subtle;
const SUBTLE_API_SUPPORTED = CRYPTO_API_SUPPORTED && typeof subtle != "undefined";
const codecBytes = codec.bytes;
const Aes = cipher.aes;
const CtrGladman = mode.ctrGladman;
const HmacSha1 = misc.hmacSha1;
let IMPORT_KEY_SUPPORTED = CRYPTO_API_SUPPORTED && SUBTLE_API_SUPPORTED && typeof subtle.importKey == "function";
let DERIVE_BITS_SUPPORTED = CRYPTO_API_SUPPORTED && SUBTLE_API_SUPPORTED && typeof subtle.deriveBits == "function";
var AESDecryptionStream = class extends TransformStream {
	constructor({ password, rawPassword, signed, encryptionStrength, checkPasswordOnly }) {
		super({
			start() {
				Object.assign(this, {
					ready: new Promise((resolve) => this.resolveReady = resolve),
					password: encodePassword(password, rawPassword),
					signed,
					strength: encryptionStrength - 1,
					pending: new Uint8Array()
				});
			},
			async transform(chunk, controller) {
				const aesCrypto = this;
				const { password, strength, resolveReady, ready } = aesCrypto;
				if (password) {
					await createDecryptionKeys(aesCrypto, strength, password, subarray(chunk, 0, SALT_LENGTH[strength] + 2));
					chunk = subarray(chunk, SALT_LENGTH[strength] + 2);
					if (checkPasswordOnly) controller.error(new Error(ERR_ABORT_CHECK_PASSWORD));
					else resolveReady();
				} else await ready;
				const output = new Uint8Array(chunk.length - SIGNATURE_LENGTH - (chunk.length - SIGNATURE_LENGTH) % BLOCK_LENGTH);
				controller.enqueue(append(aesCrypto, chunk, output, 0, SIGNATURE_LENGTH, true));
			},
			async flush(controller) {
				const { signed, ctr, hmac, pending, ready } = this;
				if (hmac && ctr) {
					await ready;
					const chunkToDecrypt = subarray(pending, 0, pending.length - SIGNATURE_LENGTH);
					const originalSignature = subarray(pending, pending.length - SIGNATURE_LENGTH);
					let decryptedChunkArray = new Uint8Array();
					if (chunkToDecrypt.length) {
						const encryptedChunk = toBits(codecBytes, chunkToDecrypt);
						hmac.update(encryptedChunk);
						decryptedChunkArray = fromBits(codecBytes, ctr.update(encryptedChunk));
					}
					if (signed) {
						const signature = subarray(fromBits(codecBytes, hmac.digest()), 0, SIGNATURE_LENGTH);
						for (let indexSignature = 0; indexSignature < SIGNATURE_LENGTH; indexSignature++) if (signature[indexSignature] != originalSignature[indexSignature]) throw new Error(ERR_INVALID_SIGNATURE);
					}
					controller.enqueue(decryptedChunkArray);
				}
			}
		});
	}
};
var AESEncryptionStream = class extends TransformStream {
	constructor({ password, rawPassword, encryptionStrength }) {
		let stream;
		super({
			start() {
				Object.assign(this, {
					ready: new Promise((resolve) => this.resolveReady = resolve),
					password: encodePassword(password, rawPassword),
					strength: encryptionStrength - 1,
					pending: new Uint8Array()
				});
			},
			async transform(chunk, controller) {
				const aesCrypto = this;
				const { password, strength, resolveReady, ready } = aesCrypto;
				let preamble = new Uint8Array();
				if (password) {
					preamble = await createEncryptionKeys(aesCrypto, strength, password);
					resolveReady();
				} else await ready;
				const output = new Uint8Array(preamble.length + chunk.length - chunk.length % BLOCK_LENGTH);
				output.set(preamble, 0);
				controller.enqueue(append(aesCrypto, chunk, output, preamble.length, 0));
			},
			async flush(controller) {
				const { ctr, hmac, pending, ready } = this;
				if (hmac && ctr) {
					await ready;
					let encryptedChunkArray = new Uint8Array();
					if (pending.length) {
						const encryptedChunk = ctr.update(toBits(codecBytes, pending));
						hmac.update(encryptedChunk);
						encryptedChunkArray = fromBits(codecBytes, encryptedChunk);
					}
					stream.signature = fromBits(codecBytes, hmac.digest()).slice(0, SIGNATURE_LENGTH);
					controller.enqueue(concat(encryptedChunkArray, stream.signature));
				}
			}
		});
		stream = this;
	}
};
function append(aesCrypto, input, output, paddingStart, paddingEnd, verifySignature) {
	const { ctr, hmac, pending } = aesCrypto;
	const inputLength = input.length - paddingEnd;
	if (pending.length) {
		input = concat(pending, input);
		output = expand(output, inputLength - inputLength % BLOCK_LENGTH);
	}
	let offset;
	for (offset = 0; offset <= inputLength - BLOCK_LENGTH; offset += BLOCK_LENGTH) {
		const inputChunk = toBits(codecBytes, subarray(input, offset, offset + BLOCK_LENGTH));
		if (verifySignature) hmac.update(inputChunk);
		const outputChunk = ctr.update(inputChunk);
		if (!verifySignature) hmac.update(outputChunk);
		output.set(fromBits(codecBytes, outputChunk), offset + paddingStart);
	}
	aesCrypto.pending = subarray(input, offset);
	return output;
}
async function createDecryptionKeys(decrypt, strength, password, preamble) {
	const passwordVerificationKey = await createKeys$1(decrypt, strength, password, subarray(preamble, 0, SALT_LENGTH[strength]));
	const passwordVerification = subarray(preamble, SALT_LENGTH[strength]);
	if (passwordVerificationKey[0] != passwordVerification[0] || passwordVerificationKey[1] != passwordVerification[1]) throw new Error(ERR_INVALID_PASSWORD);
}
async function createEncryptionKeys(encrypt, strength, password) {
	const salt = getRandomValues(new Uint8Array(SALT_LENGTH[strength]));
	return concat(salt, await createKeys$1(encrypt, strength, password, salt));
}
async function createKeys$1(aesCrypto, strength, password, salt) {
	aesCrypto.password = null;
	const baseKey = await importKey(RAW_FORMAT, password, BASE_KEY_ALGORITHM, false, DERIVED_BITS_USAGE);
	const derivedBits = await deriveBits(Object.assign({ salt }, DERIVED_BITS_ALGORITHM), baseKey, 8 * (KEY_LENGTH[strength] * 2 + 2));
	const compositeKey = new Uint8Array(derivedBits);
	const key = toBits(codecBytes, subarray(compositeKey, 0, KEY_LENGTH[strength]));
	const authentication = toBits(codecBytes, subarray(compositeKey, KEY_LENGTH[strength], KEY_LENGTH[strength] * 2));
	const passwordVerification = subarray(compositeKey, KEY_LENGTH[strength] * 2);
	Object.assign(aesCrypto, {
		keys: {
			key,
			authentication,
			passwordVerification
		},
		ctr: new CtrGladman(new Aes(key), Array.from(COUNTER_DEFAULT_VALUE)),
		hmac: new HmacSha1(authentication)
	});
	return passwordVerification;
}
async function importKey(format, password, algorithm, extractable, keyUsages) {
	if (IMPORT_KEY_SUPPORTED) try {
		return await subtle.importKey(format, password, algorithm, extractable, keyUsages);
	} catch {
		IMPORT_KEY_SUPPORTED = false;
		return misc.importKey(password);
	}
	else return misc.importKey(password);
}
async function deriveBits(algorithm, baseKey, length) {
	if (DERIVE_BITS_SUPPORTED) try {
		return await subtle.deriveBits(algorithm, baseKey, length);
	} catch {
		DERIVE_BITS_SUPPORTED = false;
		return misc.pbkdf2(baseKey, algorithm.salt, DERIVED_BITS_ALGORITHM.iterations, length);
	}
	else return misc.pbkdf2(baseKey, algorithm.salt, DERIVED_BITS_ALGORITHM.iterations, length);
}
function encodePassword(password, rawPassword) {
	if (rawPassword === void 0) return encodeText(password);
	else return rawPassword;
}
function concat(leftArray, rightArray) {
	let array = leftArray;
	if (leftArray.length + rightArray.length) {
		array = new Uint8Array(leftArray.length + rightArray.length);
		array.set(leftArray, 0);
		array.set(rightArray, leftArray.length);
	}
	return array;
}
function expand(inputArray, length) {
	if (length && length > inputArray.length) {
		const array = inputArray;
		inputArray = new Uint8Array(length);
		inputArray.set(array, 0);
	}
	return inputArray;
}
function subarray(array, begin, end) {
	return array.subarray(begin, end);
}
function fromBits(codecBytes, chunk) {
	return codecBytes.fromBits(chunk);
}
function toBits(codecBytes, chunk) {
	return codecBytes.toBits(chunk);
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/zip-crypto-stream.js
const HEADER_LENGTH = 12;
var ZipCryptoDecryptionStream = class extends TransformStream {
	constructor({ password, passwordVerification, checkPasswordOnly }) {
		super({
			start() {
				Object.assign(this, {
					password,
					passwordVerification
				});
				createKeys(this, password);
			},
			transform(chunk, controller) {
				const zipCrypto = this;
				if (zipCrypto.password) {
					const decryptedHeader = decrypt(zipCrypto, chunk.subarray(0, HEADER_LENGTH));
					zipCrypto.password = null;
					if (decryptedHeader.at(-1) != zipCrypto.passwordVerification) throw new Error(ERR_INVALID_PASSWORD);
					chunk = chunk.subarray(HEADER_LENGTH);
				}
				if (checkPasswordOnly) controller.error(new Error(ERR_ABORT_CHECK_PASSWORD));
				else controller.enqueue(decrypt(zipCrypto, chunk));
			}
		});
	}
};
var ZipCryptoEncryptionStream = class extends TransformStream {
	constructor({ password, passwordVerification }) {
		super({
			start() {
				Object.assign(this, {
					password,
					passwordVerification
				});
				createKeys(this, password);
			},
			transform(chunk, controller) {
				const zipCrypto = this;
				let output;
				let offset;
				if (zipCrypto.password) {
					zipCrypto.password = null;
					const header = getRandomValues(new Uint8Array(HEADER_LENGTH));
					header[HEADER_LENGTH - 1] = zipCrypto.passwordVerification;
					output = new Uint8Array(chunk.length + header.length);
					output.set(encrypt(zipCrypto, header), 0);
					offset = HEADER_LENGTH;
				} else {
					output = new Uint8Array(chunk.length);
					offset = 0;
				}
				output.set(encrypt(zipCrypto, chunk), offset);
				controller.enqueue(output);
			}
		});
	}
};
function decrypt(target, input) {
	const output = new Uint8Array(input.length);
	for (let index = 0; index < input.length; index++) {
		output[index] = getByte(target) ^ input[index];
		updateKeys(target, output[index]);
	}
	return output;
}
function encrypt(target, input) {
	const output = new Uint8Array(input.length);
	for (let index = 0; index < input.length; index++) {
		output[index] = getByte(target) ^ input[index];
		updateKeys(target, input[index]);
	}
	return output;
}
function createKeys(target, password) {
	const keys = [
		305419896,
		591751049,
		878082192
	];
	Object.assign(target, {
		keys,
		crcKey0: new Crc32(keys[0]),
		crcKey2: new Crc32(keys[2])
	});
	for (let index = 0; index < password.length; index++) updateKeys(target, password.charCodeAt(index));
}
function updateKeys(target, byte) {
	let [key0, key1, key2] = target.keys;
	target.crcKey0.append([byte]);
	key0 = ~target.crcKey0.get();
	key1 = getInt32(Math.imul(getInt32(key1 + getInt8(key0)), 134775813) + 1);
	target.crcKey2.append([key1 >>> 24]);
	key2 = ~target.crcKey2.get();
	target.keys = [
		key0,
		key1,
		key2
	];
}
function getByte(target) {
	const temp = target.keys[2] | 2;
	return getInt8(Math.imul(temp, temp ^ 1) >>> 8);
}
function getInt8(number) {
	return number & 255;
}
function getInt32(number) {
	return number & 4294967295;
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/zip-entry-stream.js
const ERR_INVALID_UNCOMPRESSED_SIZE = "Invalid uncompressed size";
const FORMAT_DEFLATE_RAW = "deflate-raw";
const FORMAT_DEFLATE64_RAW = "deflate64-raw";
var DeflateStream = class extends TransformStream {
	constructor(options, { chunkSize, CompressionStreamZlib, CompressionStream }) {
		super({});
		const { compressed, encrypted, useCompressionStream, zipCrypto, signed, level } = options;
		const stream = this;
		let crc32Stream, encryptionStream;
		let readable = super.readable;
		if ((!encrypted || zipCrypto) && signed) {
			crc32Stream = new Crc32Stream();
			readable = pipeThrough(readable, crc32Stream);
		}
		if (compressed) readable = pipeThroughCommpressionStream(readable, useCompressionStream, {
			level,
			chunkSize
		}, CompressionStream, CompressionStreamZlib, CompressionStream);
		if (encrypted) if (zipCrypto) readable = pipeThrough(readable, new ZipCryptoEncryptionStream(options));
		else {
			encryptionStream = new AESEncryptionStream(options);
			readable = pipeThrough(readable, encryptionStream);
		}
		setReadable(stream, readable, () => {
			let signature;
			if (encrypted && !zipCrypto) signature = encryptionStream.signature;
			if ((!encrypted || zipCrypto) && signed) signature = new DataView(crc32Stream.value.buffer).getUint32(0);
			stream.signature = signature;
		});
	}
};
var InflateStream = class extends TransformStream {
	constructor(options, { chunkSize, DecompressionStreamZlib, DecompressionStream }) {
		super({});
		const { zipCrypto, encrypted, signed, signature, compressed, useCompressionStream, deflate64 } = options;
		let crc32Stream, decryptionStream;
		let readable = super.readable;
		if (encrypted) if (zipCrypto) readable = pipeThrough(readable, new ZipCryptoDecryptionStream(options));
		else {
			decryptionStream = new AESDecryptionStream(options);
			readable = pipeThrough(readable, decryptionStream);
		}
		if (compressed) readable = pipeThroughCommpressionStream(readable, useCompressionStream, {
			chunkSize,
			deflate64
		}, DecompressionStream, DecompressionStreamZlib, DecompressionStream);
		if ((!encrypted || zipCrypto) && signed) {
			crc32Stream = new Crc32Stream();
			readable = pipeThrough(readable, crc32Stream);
		}
		setReadable(this, readable, () => {
			if ((!encrypted || zipCrypto) && signed) {
				if (signature != new DataView(crc32Stream.value.buffer).getUint32(0, false)) throw new Error(ERR_INVALID_SIGNATURE);
			}
		});
	}
};
function setReadable(stream, readable, flush) {
	readable = pipeThrough(readable, new TransformStream({ flush }));
	Object.defineProperty(stream, "readable", { get() {
		return readable;
	} });
}
function pipeThroughCommpressionStream(readable, useCompressionStream, options, CompressionStreamNative, CompressionStreamZlib, CompressionStream) {
	const Stream = useCompressionStream && CompressionStreamNative ? CompressionStreamNative : CompressionStreamZlib || CompressionStream;
	const format = options.deflate64 ? FORMAT_DEFLATE64_RAW : FORMAT_DEFLATE_RAW;
	try {
		readable = pipeThrough(readable, new Stream(format, options));
	} catch (error) {
		if (useCompressionStream) if (CompressionStreamZlib) readable = pipeThrough(readable, new CompressionStreamZlib(format, options));
		else if (CompressionStream) readable = pipeThrough(readable, new CompressionStream(format, options));
		else throw error;
		else throw error;
	}
	return readable;
}
function pipeThrough(readable, transformStream) {
	return readable.pipeThrough(transformStream);
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/codec-stream.js
const MESSAGE_EVENT_TYPE = "message";
const MESSAGE_START = "start";
const MESSAGE_DATA = "data";
const MESSAGE_CLOSE = "close";
const CODEC_INFLATE = "inflate";
var CodecStream = class extends TransformStream {
	constructor(options, config) {
		super({});
		const codec = this;
		const { codecType } = options;
		let Stream;
		if (codecType.startsWith("deflate")) Stream = DeflateStream;
		else if (codecType.startsWith("inflate")) Stream = InflateStream;
		codec.outputSize = 0;
		let inputSize = 0;
		const stream = new Stream(options, config);
		const readable = super.readable;
		const inputSizeStream = new TransformStream({
			transform(chunk, controller) {
				if (chunk && chunk.length) {
					inputSize += chunk.length;
					controller.enqueue(chunk);
				}
			},
			flush() {
				Object.assign(codec, { inputSize });
			}
		});
		const outputSizeStream = new TransformStream({
			transform(chunk, controller) {
				if (chunk && chunk.length) {
					controller.enqueue(chunk);
					codec.outputSize += chunk.length;
					if (options.outputSize !== void 0 && codec.outputSize > options.outputSize) throw new Error(ERR_INVALID_UNCOMPRESSED_SIZE);
				}
			},
			flush() {
				const { signature } = stream;
				Object.assign(codec, {
					signature,
					inputSize
				});
			}
		});
		Object.defineProperty(codec, "readable", { get() {
			return readable.pipeThrough(inputSizeStream).pipeThrough(stream).pipeThrough(outputSizeStream);
		} });
	}
};
var ChunkStream = class extends TransformStream {
	constructor(chunkSize) {
		let pendingChunk;
		super({
			transform,
			flush(controller) {
				if (pendingChunk && pendingChunk.length) controller.enqueue(pendingChunk);
			}
		});
		function transform(chunk, controller) {
			if (pendingChunk) {
				const newChunk = new Uint8Array(pendingChunk.length + chunk.length);
				newChunk.set(pendingChunk);
				newChunk.set(chunk, pendingChunk.length);
				chunk = newChunk;
				pendingChunk = null;
			}
			if (chunk.length > chunkSize) {
				controller.enqueue(chunk.slice(0, chunkSize));
				transform(chunk.slice(chunkSize), controller);
			} else pendingChunk = chunk;
		}
	}
};
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/codec-worker.js
const MODULE_WORKER_OPTIONS = { type: "module" };
let webWorkerSupported, webWorkerURI, webWorkerOptions;
let transferStreamsSupported = true;
try {
	transferStreamsSupported = typeof structuredClone == "function" && structuredClone(new DOMException("", "AbortError")).code !== void 0;
} catch {}
let initModule$1 = () => {};
function configureWorker({ initModule: initModuleFunction }) {
	initModule$1 = initModuleFunction;
}
var CodecWorker = class {
	constructor(workerData, { readable, writable }, { options, config, streamOptions, useWebWorkers, transferStreams, workerURI }, onTaskFinished) {
		const { signal } = streamOptions;
		Object.assign(workerData, {
			busy: true,
			readable: readable.pipeThrough(new ChunkStream(config.chunkSize)).pipeThrough(new ProgressWatcherStream(streamOptions), { signal }),
			writable,
			options: Object.assign({}, options),
			workerURI,
			transferStreams,
			terminate() {
				return new Promise((resolve) => {
					const { worker, busy } = workerData;
					if (worker) {
						if (busy) workerData.resolveTerminated = resolve;
						else {
							worker.terminate();
							resolve();
						}
						workerData.interface = null;
					} else resolve();
				});
			},
			onTaskFinished() {
				const { resolveTerminated } = workerData;
				if (resolveTerminated) {
					workerData.resolveTerminated = null;
					workerData.terminated = true;
					workerData.worker.terminate();
					resolveTerminated();
				}
				workerData.busy = false;
				onTaskFinished(workerData);
			}
		});
		if (webWorkerSupported === void 0) webWorkerSupported = typeof Worker != UNDEFINED_TYPE;
		return (useWebWorkers && webWorkerSupported ? createWebWorkerInterface : createWorkerInterface)(workerData, config);
	}
};
var ProgressWatcherStream = class extends TransformStream {
	constructor({ onstart, onprogress, size, onend }) {
		let chunkOffset = 0;
		super({
			async start() {
				if (onstart) await callHandler(onstart, size);
			},
			async transform(chunk, controller) {
				chunkOffset += chunk.length;
				if (onprogress) await callHandler(onprogress, chunkOffset, size);
				controller.enqueue(chunk);
			},
			async flush() {
				if (onend) await callHandler(onend, chunkOffset);
			}
		});
	}
};
async function callHandler(handler, ...parameters) {
	try {
		await handler(...parameters);
	} catch {}
}
function createWorkerInterface(workerData, config) {
	return { run: () => runWorker$1(workerData, config) };
}
function createWebWorkerInterface(workerData, config) {
	const { baseURI, chunkSize } = config;
	let { wasmURI } = config;
	if (!workerData.interface) {
		if (typeof wasmURI == "function") wasmURI = wasmURI();
		let worker;
		try {
			worker = getWebWorker(workerData.workerURI, baseURI, workerData);
		} catch {
			webWorkerSupported = false;
			return createWorkerInterface(workerData, config);
		}
		Object.assign(workerData, {
			worker,
			interface: { run: () => runWebWorker(workerData, {
				chunkSize,
				wasmURI,
				baseURI
			}) }
		});
	}
	return workerData.interface;
}
async function runWorker$1({ options, readable, writable, onTaskFinished }, config) {
	let codecStream;
	try {
		if (!options.useCompressionStream) try {
			await initModule$1(config);
		} catch {
			options.useCompressionStream = true;
		}
		codecStream = new CodecStream(options, config);
		await readable.pipeThrough(codecStream).pipeTo(writable, {
			preventClose: true,
			preventAbort: true
		});
		const { signature, inputSize, outputSize } = codecStream;
		return {
			signature,
			inputSize,
			outputSize
		};
	} catch (error) {
		if (codecStream) error.outputSize = codecStream.outputSize;
		throw error;
	} finally {
		onTaskFinished();
	}
}
async function runWebWorker(workerData, config) {
	let resolveResult, rejectResult;
	const result = new Promise((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	Object.assign(workerData, {
		reader: null,
		writer: null,
		resolveResult,
		rejectResult,
		result
	});
	const { readable, options } = workerData;
	const { writable, closed } = watchClosedStream(workerData.writable);
	const streamsTransferred = sendMessage({
		type: MESSAGE_START,
		options,
		config,
		readable,
		writable
	}, workerData);
	if (!streamsTransferred) Object.assign(workerData, {
		reader: readable.getReader(),
		writer: writable.getWriter()
	});
	const resultValue = await result;
	if (!streamsTransferred) await writable.getWriter().close();
	await closed;
	return resultValue;
}
function watchClosedStream(writableSource) {
	const { writable, readable } = new TransformStream();
	return {
		writable,
		closed: readable.pipeTo(writableSource, { preventClose: true })
	};
}
function getWebWorker(url, baseURI, workerData, isModuleType, useBlobURI = true) {
	let worker, resolvedURI, resolvedOptions;
	if (webWorkerURI === void 0) {
		const isFunctionURI = typeof url == FUNCTION_TYPE;
		if (isFunctionURI) resolvedURI = url(useBlobURI);
		else resolvedURI = url;
		const isDataURI = resolvedURI.startsWith("data:");
		const isBlobURI = resolvedURI.startsWith("blob:");
		if (isDataURI || isBlobURI) {
			if (isModuleType === void 0) isModuleType = false;
			if (isModuleType) resolvedOptions = MODULE_WORKER_OPTIONS;
			try {
				worker = new Worker(resolvedURI, resolvedOptions);
			} catch (error) {
				if (isBlobURI) try {
					URL.revokeObjectURL(resolvedURI);
				} catch {}
				if (isFunctionURI && isBlobURI) return getWebWorker(url, baseURI, workerData, isModuleType, false);
				else if (!isModuleType) return getWebWorker(url, baseURI, workerData, true, false);
				else throw error;
			}
		} else {
			if (isModuleType === void 0) isModuleType = true;
			if (isModuleType) resolvedOptions = MODULE_WORKER_OPTIONS;
			try {
				resolvedURI = new URL(resolvedURI, baseURI);
			} catch {}
			try {
				worker = new Worker(resolvedURI, resolvedOptions);
			} catch (error) {
				if (!isModuleType) return getWebWorker(url, baseURI, workerData, false, useBlobURI);
				else throw error;
			}
		}
		webWorkerURI = resolvedURI;
		webWorkerOptions = resolvedOptions;
	} else worker = new Worker(webWorkerURI, webWorkerOptions);
	worker.addEventListener(MESSAGE_EVENT_TYPE, (event) => onMessage(event, workerData));
	return worker;
}
function sendMessage(message, { worker, writer, onTaskFinished, transferStreams }) {
	try {
		const { value, readable, writable } = message;
		const transferables = [];
		if (value) {
			message.value = value;
			transferables.push(message.value.buffer);
		}
		if (transferStreams && transferStreamsSupported) {
			if (readable) transferables.push(readable);
			if (writable) transferables.push(writable);
		} else message.readable = message.writable = null;
		if (transferables.length) try {
			worker.postMessage(message, transferables);
			return true;
		} catch {
			transferStreamsSupported = false;
			message.readable = message.writable = null;
			worker.postMessage(message);
		}
		else worker.postMessage(message);
	} catch (error) {
		if (writer) writer.releaseLock();
		onTaskFinished();
		throw error;
	}
}
async function onMessage({ data }, workerData) {
	const { type, value, messageId, result, error } = data;
	const { reader, writer, resolveResult, rejectResult, onTaskFinished } = workerData;
	try {
		if (error) {
			const { message, stack, code, name, outputSize } = error;
			const responseError = new Error(message);
			Object.assign(responseError, {
				stack,
				code,
				name,
				outputSize
			});
			close(responseError);
		} else {
			if (type == "pull") {
				const { value, done } = await reader.read();
				sendMessage({
					type: MESSAGE_DATA,
					value,
					done,
					messageId
				}, workerData);
			}
			if (type == "data") {
				await writer.ready;
				await writer.write(new Uint8Array(value));
				sendMessage({
					type: "ack",
					messageId
				}, workerData);
			}
			if (type == "close") close(null, result);
		}
	} catch (error) {
		sendMessage({
			type: MESSAGE_CLOSE,
			messageId
		}, workerData);
		close(error);
	}
	function close(error, result) {
		if (error) rejectResult(error);
		else resolveResult(result);
		if (writer) writer.releaseLock();
		onTaskFinished();
	}
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/codec-pool.js
let pool = [];
const pendingRequests = [];
let indexWorker = 0;
async function runWorker(stream, workerOptions) {
	const { options, config } = workerOptions;
	const { transferStreams, useWebWorkers, useCompressionStream, compressed, signed, encrypted } = options;
	const { workerURI, maxWorkers } = config;
	workerOptions.transferStreams = transferStreams || transferStreams === void 0;
	workerOptions.useWebWorkers = !(!compressed && !signed && !encrypted && !workerOptions.transferStreams) && (useWebWorkers || useWebWorkers === void 0 && config.useWebWorkers);
	workerOptions.workerURI = workerOptions.useWebWorkers && workerURI ? workerURI : void 0;
	options.useCompressionStream = useCompressionStream || useCompressionStream === void 0 && config.useCompressionStream;
	return (await getWorker()).run();
	async function getWorker() {
		const workerData = pool.find((workerData) => !workerData.busy);
		if (workerData) {
			clearTerminateTimeout(workerData);
			return new CodecWorker(workerData, stream, workerOptions, onTaskFinished);
		} else if (pool.length < maxWorkers) {
			const workerData = { indexWorker };
			indexWorker++;
			pool.push(workerData);
			return new CodecWorker(workerData, stream, workerOptions, onTaskFinished);
		} else return new Promise((resolve) => pendingRequests.push({
			resolve,
			stream,
			workerOptions
		}));
	}
	function onTaskFinished(workerData) {
		if (pendingRequests.length) {
			const [{ resolve, stream, workerOptions }] = pendingRequests.splice(0, 1);
			resolve(new CodecWorker(workerData, stream, workerOptions, onTaskFinished));
		} else if (workerData.worker) {
			clearTerminateTimeout(workerData);
			terminateWorker(workerData, workerOptions);
		} else pool = pool.filter((data) => data != workerData);
	}
}
function terminateWorker(workerData, workerOptions) {
	const { config } = workerOptions;
	const { terminateWorkerTimeout } = config;
	if (Number.isFinite(terminateWorkerTimeout) && terminateWorkerTimeout >= 0) if (workerData.terminated) workerData.terminated = false;
	else workerData.terminateTimeout = setTimeout(async () => {
		pool = pool.filter((data) => data != workerData);
		try {
			await workerData.terminate();
		} catch {}
	}, terminateWorkerTimeout);
}
function clearTerminateTimeout(workerData) {
	const { terminateTimeout } = workerData;
	if (terminateTimeout) {
		clearTimeout(terminateTimeout);
		workerData.terminateTimeout = null;
	}
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/io.js
const ERR_ITERATOR_COMPLETED_TOO_SOON = "Writer iterator completed too soon";
const HTTP_HEADER_CONTENT_TYPE = "Content-Type";
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const PROPERTY_NAME_WRITABLE = "writable";
var Stream = class {
	constructor() {
		this.size = 0;
	}
	init() {
		this.initialized = true;
	}
};
var Reader = class extends Stream {
	get readable() {
		const reader = this;
		const { chunkSize = DEFAULT_CHUNK_SIZE } = reader;
		const readable = new ReadableStream({
			start() {
				this.chunkOffset = 0;
			},
			async pull(controller) {
				const { offset = 0, size, diskNumberStart } = readable;
				const { chunkOffset } = this;
				const dataSize = size === void 0 ? chunkSize : Math.min(chunkSize, size - chunkOffset);
				const data = await readUint8Array(reader, offset + chunkOffset, dataSize, diskNumberStart);
				controller.enqueue(data);
				if (chunkOffset + chunkSize > size || size === void 0 && !data.length && dataSize) controller.close();
				else this.chunkOffset += chunkSize;
			}
		});
		return readable;
	}
};
var BlobReader = class extends Reader {
	constructor(blob) {
		super();
		Object.assign(this, {
			blob,
			size: blob.size
		});
	}
	async readUint8Array(offset, length) {
		const reader = this;
		const offsetEnd = offset + length;
		let arrayBuffer = await (offset || offsetEnd < reader.size ? reader.blob.slice(offset, offsetEnd) : reader.blob).arrayBuffer();
		if (arrayBuffer.byteLength > length) arrayBuffer = arrayBuffer.slice(offset, offsetEnd);
		return new Uint8Array(arrayBuffer);
	}
};
var BlobWriter = class extends Stream {
	constructor(contentType) {
		super();
		const writer = this;
		const transformStream = new TransformStream();
		const headers = [];
		if (contentType) headers.push([HTTP_HEADER_CONTENT_TYPE, contentType]);
		Object.defineProperty(writer, PROPERTY_NAME_WRITABLE, { get() {
			return transformStream.writable;
		} });
		writer.blob = new Response(transformStream.readable, { headers }).blob();
	}
	getData() {
		return this.blob;
	}
};
var TextWriter = class extends BlobWriter {
	constructor(encoding) {
		super(encoding);
		Object.assign(this, {
			encoding,
			utf8: !encoding || encoding.toLowerCase() == "utf-8"
		});
	}
	async getData() {
		const { encoding, utf8 } = this;
		const blob = await super.getData();
		if (blob.text && utf8) return blob.text();
		else {
			const reader = new FileReader();
			return new Promise((resolve, reject) => {
				Object.assign(reader, {
					onload: ({ target }) => resolve(target.result),
					onerror: () => reject(reader.error)
				});
				reader.readAsText(blob, encoding);
			});
		}
	}
};
var SplitDataReader = class extends Reader {
	constructor(readers) {
		super();
		this.readers = readers;
	}
	async init() {
		const reader = this;
		const { readers } = reader;
		reader.lastDiskNumber = 0;
		reader.lastDiskOffset = 0;
		await Promise.all(readers.map(async (diskReader, indexDiskReader) => {
			await diskReader.init();
			if (indexDiskReader != readers.length - 1) reader.lastDiskOffset += diskReader.size;
			reader.size += diskReader.size;
		}));
		super.init();
	}
	async readUint8Array(offset, length, diskNumber = 0) {
		const reader = this;
		const { readers } = this;
		let result;
		let currentDiskNumber = diskNumber;
		if (currentDiskNumber == -1) currentDiskNumber = readers.length - 1;
		let currentReaderOffset = offset;
		while (readers[currentDiskNumber] && currentReaderOffset >= readers[currentDiskNumber].size) {
			currentReaderOffset -= readers[currentDiskNumber].size;
			currentDiskNumber++;
		}
		const currentReader = readers[currentDiskNumber];
		if (currentReader) {
			const currentReaderSize = currentReader.size;
			if (currentReaderOffset + length <= currentReaderSize) result = await readUint8Array(currentReader, currentReaderOffset, length);
			else {
				const chunkLength = currentReaderSize - currentReaderOffset;
				result = new Uint8Array(length);
				const firstPart = await readUint8Array(currentReader, currentReaderOffset, chunkLength);
				result.set(firstPart, 0);
				const secondPart = await reader.readUint8Array(offset + chunkLength, length - chunkLength, diskNumber);
				result.set(secondPart, chunkLength);
				if (firstPart.length + secondPart.length < length) result = result.subarray(0, firstPart.length + secondPart.length);
			}
		} else result = new Uint8Array();
		reader.lastDiskNumber = Math.max(currentDiskNumber, reader.lastDiskNumber);
		return result;
	}
};
var SplitDataWriter = class extends Stream {
	constructor(writerGenerator, maxSize = 4294967295) {
		super();
		const writer = this;
		Object.assign(writer, {
			diskNumber: 0,
			diskOffset: 0,
			size: 0,
			maxSize,
			availableSize: maxSize
		});
		let diskSourceWriter, diskWritable, diskWriter;
		const writable = new WritableStream({
			async write(chunk) {
				const { availableSize } = writer;
				if (!diskWriter) {
					const { value, done } = await writerGenerator.next();
					if (done && !value) throw new Error(ERR_ITERATOR_COMPLETED_TOO_SOON);
					else {
						diskSourceWriter = value;
						diskSourceWriter.size = 0;
						if (diskSourceWriter.maxSize) writer.maxSize = diskSourceWriter.maxSize;
						writer.availableSize = writer.maxSize;
						await initStream(diskSourceWriter);
						diskWritable = value.writable;
						diskWriter = diskWritable.getWriter();
					}
					await this.write(chunk);
				} else if (chunk.length >= availableSize) {
					await writeChunk(chunk.subarray(0, availableSize));
					await closeDisk();
					writer.diskOffset += diskSourceWriter.size;
					writer.diskNumber++;
					diskWriter = null;
					await this.write(chunk.subarray(availableSize));
				} else await writeChunk(chunk);
			},
			async close() {
				await diskWriter.ready;
				await closeDisk();
			}
		});
		Object.defineProperty(writer, PROPERTY_NAME_WRITABLE, { get() {
			return writable;
		} });
		async function writeChunk(chunk) {
			const chunkLength = chunk.length;
			if (chunkLength) {
				await diskWriter.ready;
				await diskWriter.write(chunk);
				diskSourceWriter.size += chunkLength;
				writer.size += chunkLength;
				writer.availableSize -= chunkLength;
			}
		}
		async function closeDisk() {
			await diskWriter.close();
		}
	}
};
var GenericReader = class {
	constructor(reader) {
		if (Array.isArray(reader)) reader = new SplitDataReader(reader);
		if (reader instanceof ReadableStream) reader = { readable: reader };
		return reader;
	}
};
var GenericWriter = class {
	constructor(writer) {
		if (writer.writable === void 0 && typeof writer.next == "function") writer = new SplitDataWriter(writer);
		if (writer instanceof WritableStream) writer = { writable: writer };
		if (writer.size === void 0) writer.size = 0;
		if (!(writer instanceof SplitDataWriter)) Object.assign(writer, {
			diskNumber: 0,
			diskOffset: 0,
			availableSize: INFINITY_VALUE,
			maxSize: INFINITY_VALUE
		});
		return writer;
	}
};
async function initStream(stream, initSize) {
	if (stream.init && !stream.initialized) await stream.init(initSize);
	else return Promise.resolve();
}
function readUint8Array(reader, offset, size, diskNumber) {
	return reader.readUint8Array(offset, size, diskNumber);
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/util/decode-cp437.js
const CP437 = "\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ".split("");
const VALID_CP437 = CP437.length == 256;
function decodeCP437(stringValue) {
	if (VALID_CP437) {
		let result = "";
		for (let indexCharacter = 0; indexCharacter < stringValue.length; indexCharacter++) result += CP437[stringValue[indexCharacter]];
		return result;
	} else return new TextDecoder().decode(stringValue);
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/util/decode-text.js
function decodeText(value, encoding) {
	if (encoding && encoding.trim().toLowerCase() == "cp437") return decodeCP437(value);
	else return new TextDecoder(encoding).decode(value);
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/zip-entry.js
const PROPERTY_NAME_FILENAME = "filename";
const PROPERTY_NAME_RAW_FILENAME = "rawFilename";
const PROPERTY_NAME_COMMENT = "comment";
const PROPERTY_NAME_RAW_COMMENT = "rawComment";
const PROPERTY_NAME_UNCOMPRESSED_SIZE = "uncompressedSize";
const PROPERTY_NAME_COMPRESSED_SIZE = "compressedSize";
const PROPERTY_NAME_OFFSET = "offset";
const PROPERTY_NAME_DISK_NUMBER_START = "diskNumberStart";
const PROPERTY_NAME_LAST_MODIFICATION_DATE = "lastModDate";
const PROPERTY_NAME_RAW_LAST_MODIFICATION_DATE = "rawLastModDate";
const PROPERTY_NAME_LAST_ACCESS_DATE = "lastAccessDate";
const PROPERTY_NAME_RAW_LAST_ACCESS_DATE = "rawLastAccessDate";
const PROPERTY_NAME_CREATION_DATE = "creationDate";
const PROPERTY_NAME_RAW_CREATION_DATE = "rawCreationDate";
const PROPERTY_NAMES = [
	PROPERTY_NAME_FILENAME,
	PROPERTY_NAME_RAW_FILENAME,
	PROPERTY_NAME_UNCOMPRESSED_SIZE,
	PROPERTY_NAME_COMPRESSED_SIZE,
	PROPERTY_NAME_LAST_MODIFICATION_DATE,
	PROPERTY_NAME_RAW_LAST_MODIFICATION_DATE,
	PROPERTY_NAME_COMMENT,
	PROPERTY_NAME_RAW_COMMENT,
	PROPERTY_NAME_LAST_ACCESS_DATE,
	PROPERTY_NAME_CREATION_DATE,
	PROPERTY_NAME_RAW_CREATION_DATE,
	PROPERTY_NAME_OFFSET,
	PROPERTY_NAME_DISK_NUMBER_START,
	"internalFileAttributes",
	"externalFileAttributes",
	"msdosAttributesRaw",
	"msdosAttributes",
	"msDosCompatible",
	"zip64",
	"encrypted",
	"version",
	"versionMadeBy",
	"zipCrypto",
	"directory",
	"executable",
	"compressionMethod",
	"signature",
	"extraField",
	"extraFieldUnix",
	"extraFieldInfoZip",
	"uid",
	"gid",
	"unixMode",
	"setuid",
	"setgid",
	"sticky",
	"bitFlag",
	"filenameUTF8",
	"commentUTF8",
	"rawExtraField",
	"extraFieldZip64",
	"extraFieldUnicodePath",
	"extraFieldUnicodeComment",
	"extraFieldAES",
	"extraFieldNTFS",
	"extraFieldExtendedTimestamp"
];
var Entry = class {
	constructor(data) {
		PROPERTY_NAMES.forEach((name) => this[name] = data[name]);
	}
};
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/options.js
const OPTION_FILENAME_ENCODING = "filenameEncoding";
const OPTION_COMMENT_ENCODING = "commentEncoding";
const OPTION_EXTRACT_PREPENDED_DATA = "extractPrependedData";
const OPTION_EXTRACT_APPENDED_DATA = "extractAppendedData";
const OPTION_PASSWORD = "password";
const OPTION_RAW_PASSWORD = "rawPassword";
const OPTION_PASS_THROUGH = "passThrough";
const OPTION_SIGNAL = "signal";
const OPTION_CHECK_PASSWORD_ONLY = "checkPasswordOnly";
const OPTION_CHECK_OVERLAPPING_ENTRY_ONLY = "checkOverlappingEntryOnly";
const OPTION_CHECK_OVERLAPPING_ENTRY = "checkOverlappingEntry";
const OPTION_USE_WEB_WORKERS = "useWebWorkers";
const OPTION_USE_COMPRESSION_STREAM = "useCompressionStream";
const OPTION_TRANSFER_STREAMS = "transferStreams";
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/zip-reader.js
const ERR_BAD_FORMAT = "File format is not recognized";
const ERR_EOCDR_NOT_FOUND = "End of central directory not found";
const ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND = "End of Zip64 central directory locator not found";
const ERR_CENTRAL_DIRECTORY_NOT_FOUND = "Central directory header not found";
const ERR_LOCAL_FILE_HEADER_NOT_FOUND = "Local file header not found";
const ERR_EXTRAFIELD_ZIP64_NOT_FOUND = "Zip64 extra field not found";
const ERR_ENCRYPTED = "File contains encrypted entry";
const ERR_UNSUPPORTED_ENCRYPTION = "Encryption method not supported";
const ERR_UNSUPPORTED_COMPRESSION = "Compression method not supported";
const ERR_SPLIT_ZIP_FILE = "Split zip file";
const ERR_OVERLAPPING_ENTRY = "Overlapping entry found";
const CHARSET_UTF8 = "utf-8";
const PROPERTY_NAME_UTF8_SUFFIX = "UTF8";
const CHARSET_CP437 = "cp437";
const ZIP64_PROPERTIES = [
	[PROPERTY_NAME_UNCOMPRESSED_SIZE, MAX_32_BITS],
	[PROPERTY_NAME_COMPRESSED_SIZE, MAX_32_BITS],
	[PROPERTY_NAME_OFFSET, MAX_32_BITS],
	[PROPERTY_NAME_DISK_NUMBER_START, MAX_16_BITS]
];
const ZIP64_EXTRACTION = {
	[MAX_16_BITS]: {
		getValue: getUint32,
		bytes: 4
	},
	[MAX_32_BITS]: {
		getValue: getBigUint64,
		bytes: 8
	}
};
var ZipReader = class {
	constructor(reader, options = {}) {
		Object.assign(this, {
			reader: new GenericReader(reader),
			options,
			config: getConfiguration(),
			readRanges: []
		});
	}
	async *getEntriesGenerator(options = {}) {
		const zipReader = this;
		let { reader } = zipReader;
		const { config } = zipReader;
		await initStream(reader);
		if (reader.size === void 0 || !reader.readUint8Array) {
			reader = new BlobReader(await new Response(reader.readable).blob());
			await initStream(reader);
		}
		if (reader.size < 22) throw new Error(ERR_BAD_FORMAT);
		reader.chunkSize = getChunkSize(config);
		const endOfDirectoryInfo = await seekSignature(reader, END_OF_CENTRAL_DIR_SIGNATURE, reader.size, 22, MAX_16_BITS * 16);
		if (!endOfDirectoryInfo) if (getUint32(getDataView(await readUint8Array(reader, 0, 4))) == 134695760) throw new Error(ERR_SPLIT_ZIP_FILE);
		else throw new Error(ERR_EOCDR_NOT_FOUND);
		const endOfDirectoryView = getDataView(endOfDirectoryInfo);
		let directoryDataLength = getUint32(endOfDirectoryView, 12);
		let directoryDataOffset = getUint32(endOfDirectoryView, 16);
		const commentOffset = endOfDirectoryInfo.offset;
		const commentLength = getUint16(endOfDirectoryView, 20);
		const appendedDataOffset = commentOffset + 22 + commentLength;
		let lastDiskNumber = getUint16(endOfDirectoryView, 4);
		const expectedLastDiskNumber = reader.lastDiskNumber || 0;
		let diskNumber = getUint16(endOfDirectoryView, 6);
		let filesLength = getUint16(endOfDirectoryView, 8);
		let prependedDataLength = 0;
		let startOffset = 0;
		if (directoryDataOffset == 4294967295 || directoryDataLength == 4294967295 || filesLength == 65535 || diskNumber == 65535) {
			const endOfDirectoryLocatorView = getDataView(await readUint8Array(reader, endOfDirectoryInfo.offset - 20, 20));
			if (getUint32(endOfDirectoryLocatorView, 0) == 117853008) {
				directoryDataOffset = getBigUint64(endOfDirectoryLocatorView, 8);
				let endOfDirectoryArray = await readUint8Array(reader, directoryDataOffset, 56, -1);
				let endOfDirectoryView = getDataView(endOfDirectoryArray);
				const expectedDirectoryDataOffset = endOfDirectoryInfo.offset - 20 - 56;
				if (getUint32(endOfDirectoryView, 0) != 101075792 && directoryDataOffset != expectedDirectoryDataOffset) {
					const originalDirectoryDataOffset = directoryDataOffset;
					directoryDataOffset = expectedDirectoryDataOffset;
					if (directoryDataOffset > originalDirectoryDataOffset) prependedDataLength = directoryDataOffset - originalDirectoryDataOffset;
					endOfDirectoryArray = await readUint8Array(reader, directoryDataOffset, 56, -1);
					endOfDirectoryView = getDataView(endOfDirectoryArray);
				}
				if (getUint32(endOfDirectoryView, 0) != 101075792) throw new Error(ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND);
				if (lastDiskNumber == 65535) lastDiskNumber = getUint32(endOfDirectoryView, 16);
				if (diskNumber == 65535) diskNumber = getUint32(endOfDirectoryView, 20);
				if (filesLength == 65535) filesLength = getBigUint64(endOfDirectoryView, 32);
				if (directoryDataLength == 4294967295) directoryDataLength = getBigUint64(endOfDirectoryView, 40);
				directoryDataOffset -= directoryDataLength;
			}
		}
		if (directoryDataOffset >= reader.size) {
			prependedDataLength = reader.size - directoryDataOffset - directoryDataLength - 22;
			directoryDataOffset = reader.size - directoryDataLength - 22;
		}
		if (expectedLastDiskNumber != lastDiskNumber) throw new Error(ERR_SPLIT_ZIP_FILE);
		if (directoryDataOffset < 0) throw new Error(ERR_BAD_FORMAT);
		let offset = 0;
		let directoryArray = await readUint8Array(reader, directoryDataOffset, directoryDataLength, diskNumber);
		let directoryView = getDataView(directoryArray);
		if (directoryDataLength) {
			const expectedDirectoryDataOffset = endOfDirectoryInfo.offset - directoryDataLength;
			if (getUint32(directoryView, offset) != 33639248 && directoryDataOffset != expectedDirectoryDataOffset) {
				const originalDirectoryDataOffset = directoryDataOffset;
				directoryDataOffset = expectedDirectoryDataOffset;
				if (directoryDataOffset > originalDirectoryDataOffset) prependedDataLength += directoryDataOffset - originalDirectoryDataOffset;
				directoryArray = await readUint8Array(reader, directoryDataOffset, directoryDataLength, diskNumber);
				directoryView = getDataView(directoryArray);
			}
		}
		const expectedDirectoryDataLength = endOfDirectoryInfo.offset - directoryDataOffset - (reader.lastDiskOffset || 0);
		if (directoryDataLength != expectedDirectoryDataLength && expectedDirectoryDataLength >= 0) {
			directoryDataLength = expectedDirectoryDataLength;
			directoryArray = await readUint8Array(reader, directoryDataOffset, directoryDataLength, diskNumber);
			directoryView = getDataView(directoryArray);
		}
		if (directoryDataOffset < 0 || directoryDataOffset >= reader.size) throw new Error(ERR_BAD_FORMAT);
		const filenameEncoding = getOptionValue(zipReader, options, OPTION_FILENAME_ENCODING);
		const commentEncoding = getOptionValue(zipReader, options, OPTION_COMMENT_ENCODING);
		for (let indexFile = 0; indexFile < filesLength; indexFile++) {
			const fileEntry = new ZipEntry(reader, config, zipReader.options);
			if (getUint32(directoryView, offset) != 33639248) throw new Error(ERR_CENTRAL_DIRECTORY_NOT_FOUND);
			readCommonHeader(fileEntry, directoryView, offset + 6);
			const languageEncodingFlag = Boolean(fileEntry.bitFlag.languageEncodingFlag);
			const filenameOffset = offset + 46;
			const extraFieldOffset = filenameOffset + fileEntry.filenameLength;
			const commentOffset = extraFieldOffset + fileEntry.extraFieldLength;
			const versionMadeBy = getUint16(directoryView, offset + 4);
			const msDosCompatible = versionMadeBy >> 8 == 0;
			const unixCompatible = versionMadeBy >> 8 == 3;
			const rawFilename = directoryArray.subarray(filenameOffset, extraFieldOffset);
			const commentLength = getUint16(directoryView, offset + 32);
			const endOffset = commentOffset + commentLength;
			const rawComment = directoryArray.subarray(commentOffset, endOffset);
			const filenameUTF8 = languageEncodingFlag;
			const commentUTF8 = languageEncodingFlag;
			const externalFileAttributes = getUint32(directoryView, offset + 38);
			const msdosAttributesRaw = externalFileAttributes & 255;
			const msdosAttributes = {
				readOnly: Boolean(msdosAttributesRaw & 1),
				hidden: Boolean(msdosAttributesRaw & 2),
				system: Boolean(msdosAttributesRaw & 4),
				directory: Boolean(msdosAttributesRaw & 16),
				archive: Boolean(msdosAttributesRaw & 32)
			};
			const offsetFileEntry = getUint32(directoryView, offset + 42) + prependedDataLength;
			const decode = getOptionValue(zipReader, options, "decodeText") || decodeText;
			const rawFilenameEncoding = filenameUTF8 ? CHARSET_UTF8 : filenameEncoding || CHARSET_CP437;
			const rawCommentEncoding = commentUTF8 ? CHARSET_UTF8 : commentEncoding || CHARSET_CP437;
			let filename = decode(rawFilename, rawFilenameEncoding);
			if (filename === void 0) filename = decodeText(rawFilename, rawFilenameEncoding);
			let comment = decode(rawComment, rawCommentEncoding);
			if (comment === void 0) comment = decodeText(rawComment, rawCommentEncoding);
			Object.assign(fileEntry, {
				versionMadeBy,
				msDosCompatible,
				compressedSize: 0,
				uncompressedSize: 0,
				commentLength,
				offset: offsetFileEntry,
				diskNumberStart: getUint16(directoryView, offset + 34),
				internalFileAttributes: getUint16(directoryView, offset + 36),
				externalFileAttributes,
				msdosAttributesRaw,
				msdosAttributes,
				rawFilename,
				filenameUTF8,
				commentUTF8,
				rawExtraField: directoryArray.subarray(extraFieldOffset, commentOffset),
				rawComment,
				filename,
				comment
			});
			startOffset = Math.max(offsetFileEntry, startOffset);
			readCommonFooter(fileEntry, fileEntry, directoryView, offset + 6);
			const unixExternalUpper = fileEntry.externalFileAttributes >> 16 & MAX_16_BITS;
			if (fileEntry.unixMode === void 0 && (unixExternalUpper & 16877) != 0) fileEntry.unixMode = unixExternalUpper;
			const setuid = Boolean(fileEntry.unixMode & FILE_ATTR_UNIX_SETUID_MASK);
			const setgid = Boolean(fileEntry.unixMode & FILE_ATTR_UNIX_SETGID_MASK);
			const sticky = Boolean(fileEntry.unixMode & 512);
			const executable = fileEntry.unixMode !== void 0 ? (fileEntry.unixMode & 73) != 0 : unixCompatible && (unixExternalUpper & 73) != 0;
			const modeIsDir = fileEntry.unixMode !== void 0 && (fileEntry.unixMode & 61440) == 16384;
			const upperIsDir = (unixExternalUpper & FILE_ATTR_UNIX_TYPE_MASK) == FILE_ATTR_UNIX_TYPE_DIR;
			Object.assign(fileEntry, {
				setuid,
				setgid,
				sticky,
				unixExternalUpper,
				internalFileAttribute: fileEntry.internalFileAttributes,
				externalFileAttribute: fileEntry.externalFileAttributes,
				executable,
				directory: modeIsDir || upperIsDir || msDosCompatible && msdosAttributes.directory || filename.endsWith("/") && !fileEntry.uncompressedSize,
				zipCrypto: fileEntry.encrypted && !fileEntry.extraFieldAES
			});
			const entry = new Entry(fileEntry);
			entry.getData = (writer, options) => fileEntry.getData(writer, entry, zipReader.readRanges, options);
			entry.arrayBuffer = async (options) => {
				const writer = new TransformStream();
				const [arrayBuffer] = await Promise.all([new Response(writer.readable).arrayBuffer(), fileEntry.getData(writer, entry, zipReader.readRanges, options)]);
				return arrayBuffer;
			};
			offset = endOffset;
			const { onprogress } = options;
			if (onprogress) try {
				await onprogress(indexFile + 1, filesLength, new Entry(fileEntry));
			} catch {}
			yield entry;
		}
		const extractPrependedData = getOptionValue(zipReader, options, OPTION_EXTRACT_PREPENDED_DATA);
		const extractAppendedData = getOptionValue(zipReader, options, OPTION_EXTRACT_APPENDED_DATA);
		if (extractPrependedData) zipReader.prependedData = startOffset > 0 ? await readUint8Array(reader, 0, startOffset) : new Uint8Array();
		zipReader.comment = commentLength ? await readUint8Array(reader, commentOffset + 22, commentLength) : new Uint8Array();
		if (extractAppendedData) zipReader.appendedData = appendedDataOffset < reader.size ? await readUint8Array(reader, appendedDataOffset, reader.size - appendedDataOffset) : new Uint8Array();
		return true;
	}
	async getEntries(options = {}) {
		const entries = [];
		for await (const entry of this.getEntriesGenerator(options)) entries.push(entry);
		return entries;
	}
	async close() {}
};
var ZipEntry = class {
	constructor(reader, config, options) {
		Object.assign(this, {
			reader,
			config,
			options
		});
	}
	async getData(writer, fileEntry, readRanges, options = {}) {
		const zipEntry = this;
		const { reader, offset, diskNumberStart, extraFieldAES, extraFieldZip64, compressionMethod, config, bitFlag, signature, rawLastModDate, uncompressedSize, compressedSize } = zipEntry;
		const { dataDescriptor } = bitFlag;
		const localDirectory = fileEntry.localDirectory = {};
		const dataView = getDataView(await readUint8Array(reader, offset, 30, diskNumberStart));
		let password = getOptionValue(zipEntry, options, OPTION_PASSWORD);
		let rawPassword = getOptionValue(zipEntry, options, OPTION_RAW_PASSWORD);
		const passThrough = getOptionValue(zipEntry, options, OPTION_PASS_THROUGH);
		password = password && password.length && password;
		rawPassword = rawPassword && rawPassword.length && rawPassword;
		if (extraFieldAES) {
			if (extraFieldAES.originalCompressionMethod != 99) throw new Error(ERR_UNSUPPORTED_COMPRESSION);
		}
		if (compressionMethod != 0 && compressionMethod != 8 && compressionMethod != 9 && !passThrough) throw new Error(ERR_UNSUPPORTED_COMPRESSION);
		if (getUint32(dataView, 0) != 67324752) throw new Error(ERR_LOCAL_FILE_HEADER_NOT_FOUND);
		readCommonHeader(localDirectory, dataView, 4);
		const { extraFieldLength, filenameLength, lastAccessDate, creationDate } = localDirectory;
		localDirectory.rawExtraField = extraFieldLength ? await readUint8Array(reader, offset + 30 + filenameLength, extraFieldLength, diskNumberStart) : new Uint8Array();
		readCommonFooter(zipEntry, localDirectory, dataView, 4, true);
		Object.assign(fileEntry, {
			lastAccessDate,
			creationDate
		});
		const encrypted = zipEntry.encrypted && localDirectory.encrypted && !passThrough;
		const zipCrypto = encrypted && !extraFieldAES;
		if (!passThrough) fileEntry.zipCrypto = zipCrypto;
		if (encrypted) {
			if (!zipCrypto && extraFieldAES.strength === void 0) throw new Error(ERR_UNSUPPORTED_ENCRYPTION);
			else if (!password && !rawPassword) throw new Error(ERR_ENCRYPTED);
		}
		const dataOffset = offset + 30 + filenameLength + extraFieldLength;
		const size = compressedSize;
		const readable = reader.readable;
		Object.assign(readable, {
			diskNumberStart,
			offset: dataOffset,
			size
		});
		const signal = getOptionValue(zipEntry, options, OPTION_SIGNAL);
		const checkPasswordOnly = getOptionValue(zipEntry, options, OPTION_CHECK_PASSWORD_ONLY);
		let checkOverlappingEntry = getOptionValue(zipEntry, options, OPTION_CHECK_OVERLAPPING_ENTRY);
		const checkOverlappingEntryOnly = getOptionValue(zipEntry, options, OPTION_CHECK_OVERLAPPING_ENTRY_ONLY);
		if (checkOverlappingEntryOnly) checkOverlappingEntry = true;
		const { onstart, onprogress, onend } = options;
		const deflate64 = compressionMethod == 9;
		let useCompressionStream = getOptionValue(zipEntry, options, OPTION_USE_COMPRESSION_STREAM);
		if (deflate64) useCompressionStream = false;
		const workerOptions = {
			options: {
				codecType: CODEC_INFLATE,
				password,
				rawPassword,
				zipCrypto,
				encryptionStrength: extraFieldAES && extraFieldAES.strength,
				signed: getOptionValue(zipEntry, options, "checkSignature") && !passThrough,
				passwordVerification: zipCrypto && (dataDescriptor ? rawLastModDate >>> 8 & 255 : signature >>> 24 & 255),
				outputSize: passThrough ? compressedSize : uncompressedSize,
				signature,
				compressed: compressionMethod != 0 && !passThrough,
				encrypted: zipEntry.encrypted && !passThrough,
				useWebWorkers: getOptionValue(zipEntry, options, OPTION_USE_WEB_WORKERS),
				useCompressionStream,
				transferStreams: getOptionValue(zipEntry, options, OPTION_TRANSFER_STREAMS),
				deflate64,
				checkPasswordOnly
			},
			config,
			streamOptions: {
				signal,
				size,
				onstart,
				onprogress,
				onend
			}
		};
		if (checkOverlappingEntry) await detectOverlappingEntry({
			reader,
			fileEntry,
			offset,
			diskNumberStart,
			signature,
			compressedSize,
			uncompressedSize,
			dataOffset,
			dataDescriptor: dataDescriptor || localDirectory.bitFlag.dataDescriptor,
			extraFieldZip64: extraFieldZip64 || localDirectory.extraFieldZip64,
			readRanges
		});
		let writable;
		try {
			if (!checkOverlappingEntryOnly) {
				if (checkPasswordOnly) writer = new WritableStream();
				writer = new GenericWriter(writer);
				await initStream(writer, passThrough ? compressedSize : uncompressedSize);
				({writable} = writer);
				const { outputSize } = await runWorker({
					readable,
					writable
				}, workerOptions);
				writer.size += outputSize;
				if (outputSize != (passThrough ? compressedSize : uncompressedSize)) throw new Error(ERR_INVALID_UNCOMPRESSED_SIZE);
			}
		} catch (error) {
			if (error.outputSize !== void 0) writer.size += error.outputSize;
			if (!checkPasswordOnly || error.message != "zipjs-abort-check-password") throw error;
		} finally {
			if (!getOptionValue(zipEntry, options, "preventClose") && writable && !writable.locked) await writable.getWriter().close();
		}
		return checkPasswordOnly || checkOverlappingEntryOnly ? void 0 : writer.getData ? writer.getData() : writable;
	}
};
function readCommonHeader(directory, dataView, offset) {
	const rawBitFlag = directory.rawBitFlag = getUint16(dataView, offset + 2);
	const encrypted = (rawBitFlag & 1) == 1;
	const rawLastModDate = getUint32(dataView, offset + 6);
	Object.assign(directory, {
		encrypted,
		version: getUint16(dataView, offset),
		bitFlag: {
			level: (rawBitFlag & 6) >> 1,
			dataDescriptor: (rawBitFlag & 8) == 8,
			languageEncodingFlag: (rawBitFlag & BITFLAG_LANG_ENCODING_FLAG) == BITFLAG_LANG_ENCODING_FLAG
		},
		rawLastModDate,
		lastModDate: getDate(rawLastModDate),
		filenameLength: getUint16(dataView, offset + 22),
		extraFieldLength: getUint16(dataView, offset + 24)
	});
}
function readCommonFooter(fileEntry, directory, dataView, offset, localDirectory) {
	const { rawExtraField } = directory;
	const extraField = directory.extraField = /* @__PURE__ */ new Map();
	const rawExtraFieldView = getDataView(new Uint8Array(rawExtraField));
	let offsetExtraField = 0;
	try {
		while (offsetExtraField < rawExtraField.length) {
			const type = getUint16(rawExtraFieldView, offsetExtraField);
			const size = getUint16(rawExtraFieldView, offsetExtraField + 2);
			extraField.set(type, {
				type,
				data: rawExtraField.slice(offsetExtraField + 4, offsetExtraField + 4 + size)
			});
			offsetExtraField += 4 + size;
		}
	} catch {}
	const compressionMethod = getUint16(dataView, offset + 4);
	Object.assign(directory, {
		signature: getUint32(dataView, offset + 10),
		compressedSize: getUint32(dataView, offset + 14),
		uncompressedSize: getUint32(dataView, offset + 18)
	});
	const extraFieldZip64 = extraField.get(1);
	if (extraFieldZip64) {
		readExtraFieldZip64(extraFieldZip64, directory);
		directory.extraFieldZip64 = extraFieldZip64;
	}
	const extraFieldUnicodePath = extraField.get(EXTRAFIELD_TYPE_UNICODE_PATH);
	if (extraFieldUnicodePath) {
		readExtraFieldUnicode(extraFieldUnicodePath, PROPERTY_NAME_FILENAME, PROPERTY_NAME_RAW_FILENAME, directory, fileEntry);
		directory.extraFieldUnicodePath = extraFieldUnicodePath;
	}
	const extraFieldUnicodeComment = extraField.get(EXTRAFIELD_TYPE_UNICODE_COMMENT);
	if (extraFieldUnicodeComment) {
		readExtraFieldUnicode(extraFieldUnicodeComment, PROPERTY_NAME_COMMENT, PROPERTY_NAME_RAW_COMMENT, directory, fileEntry);
		directory.extraFieldUnicodeComment = extraFieldUnicodeComment;
	}
	const extraFieldAES = extraField.get(EXTRAFIELD_TYPE_AES);
	if (extraFieldAES) {
		readExtraFieldAES(extraFieldAES, directory, compressionMethod);
		directory.extraFieldAES = extraFieldAES;
	} else directory.compressionMethod = compressionMethod;
	const extraFieldNTFS = extraField.get(10);
	if (extraFieldNTFS) {
		readExtraFieldNTFS(extraFieldNTFS, directory);
		directory.extraFieldNTFS = extraFieldNTFS;
	}
	const extraFieldUnix = extraField.get(EXTRAFIELD_TYPE_UNIX);
	if (extraFieldUnix) {
		readExtraFieldUnix(extraFieldUnix, directory, false);
		directory.extraFieldUnix = extraFieldUnix;
	} else {
		const extraFieldInfoZip = extraField.get(EXTRAFIELD_TYPE_INFOZIP);
		if (extraFieldInfoZip) {
			readExtraFieldUnix(extraFieldInfoZip, directory, true);
			directory.extraFieldInfoZip = extraFieldInfoZip;
		}
	}
	const extraFieldExtendedTimestamp = extraField.get(EXTRAFIELD_TYPE_EXTENDED_TIMESTAMP);
	if (extraFieldExtendedTimestamp) {
		readExtraFieldExtendedTimestamp(extraFieldExtendedTimestamp, directory, localDirectory);
		directory.extraFieldExtendedTimestamp = extraFieldExtendedTimestamp;
	}
	const extraFieldUSDZ = extraField.get(EXTRAFIELD_TYPE_USDZ);
	if (extraFieldUSDZ) directory.extraFieldUSDZ = extraFieldUSDZ;
}
function readExtraFieldZip64(extraFieldZip64, directory) {
	directory.zip64 = true;
	const extraFieldView = getDataView(extraFieldZip64.data);
	const missingProperties = ZIP64_PROPERTIES.filter(([propertyName, max]) => directory[propertyName] == max);
	for (let indexMissingProperty = 0, offset = 0; indexMissingProperty < missingProperties.length; indexMissingProperty++) {
		const [propertyName, max] = missingProperties[indexMissingProperty];
		if (directory[propertyName] == max) {
			const extraction = ZIP64_EXTRACTION[max];
			directory[propertyName] = extraFieldZip64[propertyName] = extraction.getValue(extraFieldView, offset);
			offset += extraction.bytes;
		} else if (extraFieldZip64[propertyName]) throw new Error(ERR_EXTRAFIELD_ZIP64_NOT_FOUND);
	}
}
function readExtraFieldUnicode(extraFieldUnicode, propertyName, rawPropertyName, directory, fileEntry) {
	const extraFieldView = getDataView(extraFieldUnicode.data);
	const crc32 = new Crc32();
	crc32.append(fileEntry[rawPropertyName]);
	const dataViewSignature = getDataView(new Uint8Array(4));
	dataViewSignature.setUint32(0, crc32.get(), true);
	const signature = getUint32(extraFieldView, 1);
	Object.assign(extraFieldUnicode, {
		version: getUint8(extraFieldView, 0),
		[propertyName]: decodeText(extraFieldUnicode.data.subarray(5)),
		valid: !fileEntry.bitFlag.languageEncodingFlag && signature == getUint32(dataViewSignature, 0)
	});
	if (extraFieldUnicode.valid) {
		directory[propertyName] = extraFieldUnicode[propertyName];
		directory[propertyName + PROPERTY_NAME_UTF8_SUFFIX] = true;
	}
}
function readExtraFieldAES(extraFieldAES, directory, compressionMethod) {
	const extraFieldView = getDataView(extraFieldAES.data);
	const strength = getUint8(extraFieldView, 4);
	Object.assign(extraFieldAES, {
		vendorVersion: getUint8(extraFieldView, 0),
		vendorId: getUint8(extraFieldView, 2),
		strength,
		originalCompressionMethod: compressionMethod,
		compressionMethod: getUint16(extraFieldView, 5)
	});
	directory.compressionMethod = extraFieldAES.compressionMethod;
}
function readExtraFieldNTFS(extraFieldNTFS, directory) {
	const extraFieldView = getDataView(extraFieldNTFS.data);
	let offsetExtraField = 4;
	let tag1Data;
	try {
		while (offsetExtraField < extraFieldNTFS.data.length && !tag1Data) {
			const tagValue = getUint16(extraFieldView, offsetExtraField);
			const attributeSize = getUint16(extraFieldView, offsetExtraField + 2);
			if (tagValue == 1) tag1Data = extraFieldNTFS.data.slice(offsetExtraField + 4, offsetExtraField + 4 + attributeSize);
			offsetExtraField += 4 + attributeSize;
		}
	} catch {}
	try {
		if (tag1Data && tag1Data.length == 24) {
			const tag1View = getDataView(tag1Data);
			const rawLastModDate = tag1View.getBigUint64(0, true);
			const rawLastAccessDate = tag1View.getBigUint64(8, true);
			const rawCreationDate = tag1View.getBigUint64(16, true);
			Object.assign(extraFieldNTFS, {
				rawLastModDate,
				rawLastAccessDate,
				rawCreationDate
			});
			const extraFieldData = {
				lastModDate: getDateNTFS(rawLastModDate),
				lastAccessDate: getDateNTFS(rawLastAccessDate),
				creationDate: getDateNTFS(rawCreationDate)
			};
			Object.assign(extraFieldNTFS, extraFieldData);
			Object.assign(directory, extraFieldData);
		}
	} catch {}
}
function readExtraFieldUnix(extraField, directory, isInfoZip) {
	try {
		const view = getDataView(new Uint8Array(extraField.data));
		let offset = 0;
		const version = getUint8(view, offset++);
		const uidSize = getUint8(view, offset++);
		const uidBytes = extraField.data.subarray(offset, offset + uidSize);
		offset += uidSize;
		const uid = unpackUnixId(uidBytes);
		const gidSize = getUint8(view, offset++);
		const gidBytes = extraField.data.subarray(offset, offset + gidSize);
		offset += gidSize;
		const gid = unpackUnixId(gidBytes);
		let unixMode = void 0;
		if (!isInfoZip && offset + 2 <= extraField.data.length) {
			const base = extraField.data;
			unixMode = new DataView(base.buffer, base.byteOffset + offset, 2).getUint16(0, true);
		}
		Object.assign(extraField, {
			version,
			uid,
			gid,
			unixMode
		});
		if (uid !== void 0) directory.uid = uid;
		if (gid !== void 0) directory.gid = gid;
		if (unixMode !== void 0) directory.unixMode = unixMode;
	} catch {}
}
function unpackUnixId(bytes) {
	const buffer = new Uint8Array(4);
	buffer.set(bytes, 0);
	return new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true);
}
function readExtraFieldExtendedTimestamp(extraFieldExtendedTimestamp, directory, localDirectory) {
	const extraFieldView = getDataView(extraFieldExtendedTimestamp.data);
	const flags = getUint8(extraFieldView, 0);
	const timeProperties = [];
	const timeRawProperties = [];
	if (localDirectory) {
		if ((flags & 1) == 1) {
			timeProperties.push(PROPERTY_NAME_LAST_MODIFICATION_DATE);
			timeRawProperties.push(PROPERTY_NAME_RAW_LAST_MODIFICATION_DATE);
		}
		if ((flags & 2) == 2) {
			timeProperties.push(PROPERTY_NAME_LAST_ACCESS_DATE);
			timeRawProperties.push(PROPERTY_NAME_RAW_LAST_ACCESS_DATE);
		}
		if ((flags & 4) == 4) {
			timeProperties.push(PROPERTY_NAME_CREATION_DATE);
			timeRawProperties.push(PROPERTY_NAME_RAW_CREATION_DATE);
		}
	} else if (extraFieldExtendedTimestamp.data.length >= 5) {
		timeProperties.push(PROPERTY_NAME_LAST_MODIFICATION_DATE);
		timeRawProperties.push(PROPERTY_NAME_RAW_LAST_MODIFICATION_DATE);
	}
	let offset = 1;
	timeProperties.forEach((propertyName, indexProperty) => {
		if (extraFieldExtendedTimestamp.data.length >= offset + 4) {
			const time = getUint32(extraFieldView, offset);
			directory[propertyName] = extraFieldExtendedTimestamp[propertyName] = /* @__PURE__ */ new Date(time * 1e3);
			const rawPropertyName = timeRawProperties[indexProperty];
			extraFieldExtendedTimestamp[rawPropertyName] = time;
		}
		offset += 4;
	});
}
async function detectOverlappingEntry({ reader, fileEntry, offset, diskNumberStart, signature, compressedSize, uncompressedSize, dataOffset, dataDescriptor, extraFieldZip64, readRanges }) {
	let diskOffset = 0;
	if (diskNumberStart) for (let indexReader = 0; indexReader < diskNumberStart; indexReader++) {
		const diskReader = reader.readers[indexReader];
		diskOffset += diskReader.size;
	}
	let dataDescriptorLength = 0;
	if (dataDescriptor) if (extraFieldZip64) dataDescriptorLength = 20;
	else dataDescriptorLength = 12;
	if (dataDescriptorLength) {
		const dataDescriptorArray = await readUint8Array(reader, dataOffset + compressedSize, dataDescriptorLength + 4, diskNumberStart);
		if (getUint32(getDataView(dataDescriptorArray), 0) == 134695760) {
			const readSignature = getUint32(getDataView(dataDescriptorArray), 4);
			let readCompressedSize;
			let readUncompressedSize;
			if (extraFieldZip64) {
				readCompressedSize = getBigUint64(getDataView(dataDescriptorArray), 8);
				readUncompressedSize = getBigUint64(getDataView(dataDescriptorArray), 16);
			} else {
				readCompressedSize = getUint32(getDataView(dataDescriptorArray), 8);
				readUncompressedSize = getUint32(getDataView(dataDescriptorArray), 12);
			}
			if ((fileEntry.encrypted && !fileEntry.zipCrypto || readSignature == signature) && readCompressedSize == compressedSize && readUncompressedSize == uncompressedSize) dataDescriptorLength += 4;
		}
	}
	const range = {
		start: diskOffset + offset,
		end: diskOffset + dataOffset + compressedSize + dataDescriptorLength,
		fileEntry
	};
	for (const otherRange of readRanges) if (otherRange.fileEntry != fileEntry && range.start >= otherRange.start && range.start < otherRange.end) {
		const error = new Error(ERR_OVERLAPPING_ENTRY);
		error.overlappingEntry = otherRange.fileEntry;
		throw error;
	}
	readRanges.push(range);
}
async function seekSignature(reader, signature, startOffset, minimumBytes, maximumLength) {
	const signatureArray = new Uint8Array(4);
	setUint32(getDataView(signatureArray), 0, signature);
	const maximumBytes = minimumBytes + maximumLength;
	return await seek(minimumBytes) || await seek(Math.min(maximumBytes, startOffset));
	async function seek(length) {
		const offset = startOffset - length;
		const bytes = await readUint8Array(reader, offset, length);
		for (let indexByte = bytes.length - minimumBytes; indexByte >= 0; indexByte--) if (bytes[indexByte] == signatureArray[0] && bytes[indexByte + 1] == signatureArray[1] && bytes[indexByte + 2] == signatureArray[2] && bytes[indexByte + 3] == signatureArray[3]) return {
			offset: offset + indexByte,
			buffer: bytes.slice(indexByte, indexByte + minimumBytes).buffer
		};
	}
}
function getOptionValue(zipReader, options, name) {
	return options[name] === void 0 ? zipReader.options[name] : options[name];
}
function getDate(timeRaw) {
	const date = (timeRaw & 4294901760) >> 16, time = timeRaw & MAX_16_BITS;
	try {
		return new Date(1980 + ((date & 65024) >> 9), ((date & 480) >> 5) - 1, date & 31, (time & 63488) >> 11, (time & 2016) >> 5, (time & 31) * 2, 0);
	} catch {}
}
function getDateNTFS(timeRaw) {
	return new Date(Number(timeRaw / BigInt(1e4) - BigInt(0xa9730b66800)));
}
function getUint8(view, offset) {
	return view.getUint8(offset);
}
function getUint16(view, offset) {
	return view.getUint16(offset, true);
}
function getUint32(view, offset) {
	return view.getUint32(offset, true);
}
function getBigUint64(view, offset) {
	return Number(view.getBigUint64(offset, true));
}
function setUint32(view, offset, value) {
	view.setUint32(offset, value, true);
}
function getDataView(array) {
	return new DataView(array.buffer);
}
new Uint8Array([
	7,
	0,
	2,
	0,
	65,
	69,
	3,
	0,
	0
]);
//#endregion
//#region node_modules/@zip.js/zip.js/lib/zip-core-base.js
try {
	configure({ baseURI: import.meta.url });
} catch {}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/zlib-streams-inline.js
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function g(g) {
	let B;
	g({ wasmURI: () => (B || (B = "data:application/wasm;base64," + ((g) => {
		g = ((g) => {
			const B = (g = (g + "").replace(/[^A-Za-z0-9+/=]/g, "")).length, E = [];
			for (let I = 0; B > I; I += 4) {
				const B = A.indexOf(g[I]) << 18 | A.indexOf(g[I + 1]) << 12 | (63 & A.indexOf(g[I + 2])) << 6 | 63 & A.indexOf(g[I + 3]);
				E.push(B >> 16 & 255), "=" !== g[I + 2] && E.push(B >> 8 & 255), "=" !== g[I + 3] && E.push(255 & B);
			}
			return new Uint8Array(E);
		})(g);
		let B = new Uint8Array(1024), E = 0;
		for (let A = 0; A < g.length;) {
			const C = g[A++];
			if (128 & C) {
				const Q = 3 + (127 & C), D = g[A++] << 8 | g[A++], o = E - D;
				I(E + Q);
				for (let A = 0; Q > A; A++) B[E++] = B[o + A];
			} else {
				const Q = C;
				I(E + Q);
				for (let I = 0; Q > I && A < g.length; I++) B[E++] = g[A++];
			}
		}
		return ((g) => {
			let B = "";
			const E = g.length;
			let I = 0;
			for (; E > I + 2; I += 3) {
				const E = g[I] << 16 | g[I + 1] << 8 | g[I + 2];
				B += A[E >> 18 & 63] + A[E >> 12 & 63] + A[E >> 6 & 63] + A[63 & E];
			}
			const C = E - I;
			if (1 === C) {
				const E = g[I] << 16;
				B += A[E >> 18 & 63] + A[E >> 12 & 63] + "==";
			} else if (2 === C) {
				const E = g[I] << 16 | g[I + 1] << 8;
				B += A[E >> 18 & 63] + A[E >> 12 & 63] + A[E >> 6 & 63] + "=";
			}
			return B;
		})(new Uint8Array(B.buffer.slice(0, E)));
		function I(A) {
			if (B.length < A) {
				let g = 2 * B.length;
				for (; A > g;) g *= 2;
				const I = new Uint8Array(g);
				I.set(B.subarray(0, E)), B = I;
			}
		}
	})("FQBhc20BAAAAAUULYAF/AX9gAn9/AIEABYAACwIDf4IABwEBgAARAQaAAAuDAA6BABUDAGAAgAADgAANAQSBABUDAGAHgwAegAAfEgNCQQcABAEABAgIAAIABQIKAIAAB4EAAwEFgQAHAgICgQAHEAEDAAUGAAMDBQQJBAQJAQaAAAEeAAIEAwIEAgIBBAcDAwQFAXABDQ0FBgEBggKCAgYIgACYIkHQ1QQLB4oEHAZtZW1vcnkCAAxpbmZsYXRlOV9uZXcABw2GAA8HaW5pdAAIEYoAEAdfcmF3AAoQhgAUCXByb2Nlc3MAC4cARgZlbmQADhaGAA8QbGFzdF9jb25zdW1lZAARC4QAGYMAbYUANoMAbAEShQBYhwBrARSFAH+DABMHZ3ppcAAVD4UAFIUAfgEWhgBWgQB9AhgVhQAOjQB8AmRliQB8hQAOggB8AhoQiQAPggB8AhsRigATggB8AhwPhQAUhQB8AR2GAFaBAHwJHwRmcmVlAAIVhQAVjACDCgZtYWxsb2MAAQuCAFUKaWFsaXplAAAZX4AADxZkaXJlY3RfZnVuY3Rpb25fdGFibGUBgAAcG2Vtc2NyaXB0ZW5fc3RhY2tfcmVzdG9yZQAFHI4AGwJnZYAAbw51cnJlbnQABiJfX2N4YYAAWwRjcmVtgAASBl9leGNlcIIAXQZyZWZjb3WAACUtPQkSAQBBAQsMACEiDA8XGR4+NTg7CqHlAkECAAu/JwELfyMAQRBrIgokAAJAjwACEiAAQfQBTQRAQaQnKAIAIgNBEIAAEgYLakH4A3GBAAkQSRsiBkEDdiIAdiIBQQNxBIEAMgYBQX9zQQGAAB8GaiICQQN0gAAZDMwnaiIAIAEoAtQnIoAABgQIIgVGggBSCSADQX4gAndxNoACphEBCyAFIAA2AgwgACAFNgIIC4AASAMIaiGAADcBIIIARoAABQRyNgIEgQAPA2oiAYEATQMEQQGBABIHDAsLIAZBrIIAnwMITQ2AABuBAIYEQQIgAIEANQUAIAJrcoAANQQAdHFogQCjA3QiAIIAj4AAH4IAj4AABosAjwUBd3EiA4YAkQECgQCRAQKEAJEBAIAAaIMAhYAACgJqIoAAjIIA3wUgBmsiBYMAjIAAGQIBaoEALgoAIAgEQCAIQXhxgQBuBCEBQbiBAKAEIQICf4AAZQEBgAAZBwN2dCIHcUWEAHgCIAeAAD6AADyBAHWBASEDCyEDgQDpgAB2gAAchACEAQGDAAeAAJyBAIuCARyAAFYCIASAADmAAP6CAHWAAQsCQaiCAQkCC0WAAQkFC2hBAnSAAOYDKSICgQEuAnhxgACqByEEIAIhAQOCAagFKAIQIgCAAIOBAAoBFIAACgENgAB+gAEQhAAqgADZgQFuBQRJIgEbgAA2gAFJASCAAAmAATgBIYEApwILIIAAVAMYIQmAABaAAAkEDCIAR4AASIAACgEIgAA3hAHGgACxAwgMCoIAKQUUIgEEf4AByAIUaoABU4EAdwMBRQ2AANkOQRBqCyEFA0AgBSEHIAGAAZoDFGohgAIFggAwAg0AgADlARCEABCAADEGDQALIAdBgABbCAAMCQtBfyEGgAAfA79/S4IAJwELgAISgAC1AiEGhAD+CAdFDQBBHyEIgAH+ggDygALEA///B4ACxoABwQEmgQJYBnZnIgBrdoICpQpBAXRrQT5qIQgLhALxAQiFATUBAYEBngIAIYECCoEAB4AAPAEZgAAdAwF2a4AAVwgIQR9HG3QhAoUBSYUBNAQDIARPgACTAQGAALcDAyIEgACGAQCAAH8BAYAARAEDgQI/ggFoAQOAAdOBAtQGHXZBBHFqggDcAkYbgAAdAgMbgABkAQKAAI+AAWSBAO6BADECBXKDAIQBBYACzwEIgQK7gADugALPAgdxgQGuAwMgAIUB4QEhgAEdggHAgAFMiAHCAQKAAb4BIYAAbIEByYMBxAEFgQAJhQFTgAGTAQGDAW8DCyIAggByAQWAATkCIASDA02AAEGBAMsBBYEB5wEIgAA5gAAJhAHngAAKjQHngAKTgAAWgwHnAQWCAeeAAA+EAecBBYIB54ABK4ACeoAA+4MB54IDgIgB54IAEIQB5wEDgwHnAQeHA9gBBYEEgoMDQ4AEpoAAjYECnwNBEE+AAI2CA4uAATKGA4ECBWqBAJOAAFeFA66BA1WAABeGA7sBBYsEQIABX4AEJwEhgAHlgANGgQA6gQNWgAN0gQCZgQNlgAJvgABKAbCCAIgCAkmAAIgBsIAAH4IAgYEALAK8J4AAA4EAG4MAiIEAN4kAjYYEMYUAS4QCSgEvgAQ/BQJ/QfwqgAA7gABTAoQrgAAIgQJoBYgrQn83gABXBoArQoCggIAAAQEEgQAOEfwqIApBDGpBcHFB2KrVqgVzgQB6ApArggEnA0HgKoMACAaAIAsiAWqABaKAAZMBa4AEXIEEmQVNDQhB3IEAZAIiBYAAZgHUggAKAQiABKMFIgkgCE2AAUcFCUlyDQmAAvmAAEUDLQAAgAKQgAJvhQX6hADYgQA5BOQqIQCDAlqBAD+BAY2AADwBCIICagNqSQ2BAtuBAhKCAkMEQQAQBIAFdwJ/RoAB+QMBIQOAAMmCAR0BQYAAk4AD+4AGIYEC/AFrgQVTAWqCAs0DcWohgABAAQOBAKsBA4QAq4EBEYMAq4ADRQNqIgeAAHGAAUoBB4AAqwEEgAAqgABfgAFjBUcNAQwFgQA4gABMgADrgQAWggJCgABTgQCVAUaABP4BAoIDFYEAioABCQVBMGogA4EAuIAB7QMMBAuDAXGBAyADIANrgQCJBwJrcSICEASDAC6ABWWAAJaCACuAAJyAAM0ERw0CC4EBaAHggQCWAkEEgQWsgAWohADpggDygQBoAXKBBSQDTXINgANTgABQgAPoCAZBKGpNDQULgADOgwDRgQDPggGsAdiCAA4BAIECTgLYKoEDSQEAgQGFgwFxAQSHAXGDANOBA2uAANUCIgWAANeCABKDAWuBAMcBtIMCe4EBSoAAewEbgQQtAbSDAr2CAmkDQegqgQYwAQCAAFCCABUFQcQnQX+BAAgCyCeDAnuBAAwB8IMCQIEB4IMGz4MHsIAGUAHUgAMQgQZYAtgngQUngAC7A0EgR4AAeYEDAQQDQShrgAAQAXiAAOkBQYECa4AB3oMDDoQHoIIGzoADdIUDCAQCakEogQNsBMAnQYyBAXuBA+CAAc6AAYEBTYEGZAJLcoMA2gQMQQhxgQAKgAHZAgVqgQAwgABRgATNAiAEggBmgAhRggN0ArAngwOPgQFPgAAtgACJgwBvgAClggBvgABWkABvAQOCARMCDAaDAAeFAT0DIAJLiAE1gwH7AQWCAYACAkCBBpmEAYKBBPeEAXoDAQwCgQWcAi0AgQCtgATgAQuEAa6BCSyDAa4BBIECaYEHPIICjAMiBUmEB1kBCIIGTJQBQAEHkAFAAQeZAUCAAGICBUGAB/iBAEEDakEvgABPgAAoAQSABUyACZQDAUEbggksCUHsKikCADcCEIAACwHkgwALAQiAABSCCVuBAHCNAiCEAgyAACABGIAEr4ICE4AAmIMEv4AABQEEgQmQgADPgQL+AyAERoEG6YMFSQF+gAnDAQSDCC+ABnaEALaCCMEBAIAI8gMCQf+BCkOAAAiECQ+AABWEClCABSqBCd+ACQ0BAoUJDYAAEYIJDYIJgoEBNgELgAbDgADagQkNgABggAZ1AkEMgAWyAQiBBS8BH4IHMwH/hAfdAQKAB92AABmQB92AALGAAMUGNgIcIARCggEPAQCABzkDQdQpgAmaggTrgwg3gAKvgQo1AQOCAIoBqIEJlwEFgwmXggllgQCPAQKACAOAAFWCCAOACGKBCAOCB9aAB6KBAi2BCt2CB3wBAoIDqoAH44EHbIEH04MDDoAH8AIiA4EG5wEFggbngQBXARCBAJqAAe8DGEEIgAcEAgQigAgsAkEMhQoHgAHTgQDwgwCBAQiDAMOACNWAACMBGIABAgEMgAA7hAbsgQLygwRHhAapgAZkAU2ACH6AAmqBB8ixBquAAyEEoCdBMIEAOYEDMIIIwIMHFoIC14ADKIIDa4UCwwFqgAYZhQBCgAmMgAaDggAVgAUFAiAIgAbsA2shB4UE4QIgA4ELboED2YoDzAEHgwUbgQDlhAvYgAHgggfzgwAxhwrrhAifjgAxgQIlgwEGgQFAgAFogQWXBANxQQGAAD+AACSACiABCYEAFoACPYIM14MClIAAEYEIzAECgwwCgwKWgAwGgAA5AXaDDJgBAoEC7IcLg4ECd4EANQMYIQaAAEaABC+BBBqCAEWCAR+BACaBAaWAACaAAB+AABiAC1iACRMBA4IJE4IB+4EJp4AAEIEJE4ALh4IKKoAGiYEJE4IEMIAAMIADV4ELGoEJuYIAMYECLAEFgwkTggqKgACSAQaACaiDAGABHIAA5AECgAW2gQoGggEpgAF+gALYgwGrAwINAYACyIMC3oEA1YUA0oEAOwIgBoAAXYEAMAEGgQAsARCBANeCAAoBFIAC5oIMCoAI5IACl4QAtYEDXoEA2YADOoEAJQEYggEEggw0gQJFgAAZARSGABkEByAJaoALzwEDgAAHgQLtAQSBA32AB02GBCSFBNWAAAoCaiCBBPaAABKDAYwBB5MEIAEHrQQggwMpgQAHhAGxgAQoAQKBAGaEBCgBB4AEKAEHkgQogAFbgALUiAQogA8mgwQogg8dhAQoggS1A3QiBYUEKIAD24MAkoYEKAEHgAQogAUHggQoAQKEDCuCBh6DAfSBDnaCBCgBB4EEKIEMC4EB7YML+4EFfYEEKIMLQIIB/IYEKIAA1gEYgAAHhADkgQDyhQEEgQZ2gwuPgwQqgQIvgQAriAEIAQuADLWCA9qCAgABCIMCQoAAZgEcgADQgADOgAJsgAJCgQ8KgACKgQJCggNdgAbvgQDiAQeEDxmBAa+DAECACgCEAkCACgiEAkCCAAqAAkCEDkoCIAiBAISDAMiCC6mAAIaABomCAMaFDC+BAkCCABkBFIUAGYAAXAMEQQ+DCmMBBIEEqYADi4cLuYMEfYYEIYEMCoQAH4AACoEEb4QAHIEFXQFqggGPgAASgwJegQFxkAJeAQSiAl6BD3aAAByAAAcBDIECzYMAB4cCXoIAZoQCXgEEgAJeAQSVBoaCADwDHCADkQaGgQMaghC1hQJYgAK0hAaAgQelgwBxARiBAJgBBJYGh4MCX4UP74AHo4QGh4IJHYEAJoEF8oECXwEHhw9VgQBeARCDEGiBA9iFAOWBAPOCBvSDBN2CABaDEH+DDaGABBuDBPKCANSBDgGDAl+CBPoBCYMCX4AAPIQCX4AB74ACX4EFZ4AAKI0CXwELgwJfhgJdAwIgCYQCXQEJhgJdggAKiAJdAQmBAIKDEEyPAl2DEHOZAl2BC/uKAl2ACXaNAl2ABQKEAB+AAAqAA5KGAl2AAm6EAl2KEeaBDjqCAYWAAmGGEeQBIIMIT4gR5ogCW4ABO4ICRoMB3IEH6YICW4IB8QEIgQb/ghHXgQ6ZgQBugQiAgQFjAQuADg4DEGokgABKBgveCwEIf4EGz4IA7AJBCIEMd4AJqAFrgwLeAXiBCzQCIQWCE5QCAXGBCa8BQYACXYEGgIEFv4AAIoAAL4MLB4AKo4ISvIME6IAE6oQHeoQG3oAHNIAAPIQJxoMG7wEEgA0ViQcygBMMhAcygQ2YggchigcfiwdFgQ3KhRAwiAcdghAwgwcdAQSAAsoBBIISF4IHHYABhIUQMIIHHYIAEIsSF4AIo4ACZoAJQ4EH9QIDR4AOUIABOIICZ4AQ9oQGf4EBHoMBxIIUbQIAD4QF8YEAmYIFUIAN6Y4HYoICwQEEhwdiAQSWB2KJAsWrB2KBAsWCARyBAsWIB2KCAsWCABmBAsWFA6MBBYQRmoEA7QEBgAHShhW7gwHigglggQHAghTZgAlrggvlhglrgA1IggEXhwENAQODAfACRw2BEXGDEE8BuIMACAEPhAmFgQ/4hAmHggBNhgmHjwBNgQ2YhQFdgQKEgAAjgQw3iwJGghJEgAF7jAl4igJGiwGagAIzghKMgQJXAQWIEoeJAleDAgOREoeAADS0AleAAg2RAkCGAOaDDlmHAjOHB1ODAjOCB1OjAjOABsSjAjOGB1WMAjOHB1WOAjOOALiAABQBCIAPz4UDJYABrYULFIELLIMWt4YHKoAE+oILFIAUhIUEz4AG9I0WtYQGq4AICIUGRYIE1oMGIYACSoEJh4AAZYQHKQEAgAcpgASzgAcpAQGDBymAAsyGCYeCBlyGBymGCYeAEzWAAucBf4sJiYMXSIIJiYMFYoABqIECpIENJYMJIpEJj4ABnoAVnYECD4YNtwEAhgmPgQzagxWKgAG7hgcwgBXRhQcwgQBdgAu9gAfpgQD3AgMihgEGgALVggD8gwEKgAAngADjgRRhAQuAAnWBEF6DBjiEARqCAY2CD/qAEZoBxIICEoAFlIASTQIgAIAPwYATTwSMCwEHgAANgQWagAXHgxBjgRJ3ggXOgAEWggXOghB3gACOhAhIgQAmgRKBhAaPhBC7AQyABm2FD4mAAZGRBcOBD4mGA32AACKBA2yEBgSCADCCB/6BAc+BGJmBA5CCDLABBIADbIEV04QWVgEEghaZiBXzAQeAAWGBBeOAATCCBNKAAUWCBeODABCFAVWLBcOAAIqHBcOCDuKAFD2EA4OBBsaFBcOBABuCBcOEAJmHBcOAAEqEA5CAAJYBHIAAUYYDkAEAhwOQgwlXiwOQhBqPggOQgA8VhgOQgQH1gwOQgAAKgAOQAQOCA5CABeWBA5CCAPoBAoIBWoEDuIMJKIADd4IBIYADuoEB8YEDx4UAGYYFr4QA7pEFtIIFhoYFtIATf4QW1oYPsqkFtIIAH4YFtJAATYEauIQBToERp4ICTYMFtIcCN4QFtIIPj5UCN4sBi4cFtIAGtIYFtIsCSIUFtIECSIgFtIACSIUFtK8CSIIFtI8CMYYA5oMFtIcCJIIFtIgCJIgFtJ0CJIkFtJoCJIIA1pACJIIA/ZACJJEAuIENVYQFtIQBrYUHUIEHaYIFtIAcY4YdrIEVzIEFtIAII4UM3oEK0IAEHoUL2YEM3oMQsoUKfIQQx4MKmIIFtIAErIYFtAEBhhtAAQKDBbSBBSeCBbSCEiGAALkDHCAAgwW0AQOFBbSAEW+GDzuBBkiAFmWGBbKAEAWDAJGEDBCCBq+CBUuABbOAAMGCBbMBA4MFs4ABH4EFs4ICDoEBqIIFswEBgQWzAQOBBbOBAAeABbOAAnqAAJWGBbMBAoMFs4QQu4AClYIBWYQA6oMGl4EGCoYa0IMTZIADXYIM4oQTgIMBDQMLC0mBBxEBkIMGe4EVGwFqgQtiAQKCCzWAAHSCA1CCF4UDIAA/gAUCAXSAHo2HE0UBf4ABTAGQhAqQAwELBoAALQYkAAsEACOAE7MCAQGABtUEQcQAEIAQGYMLyAIEa4EZj4AMOoIADoAGHgMA/AuBGM6CBWuAASMBJIEHjQU2AiAgAIASGQMLCxGAACaBAVEBfoIHxQsQEAkL2QIBA39BeoAHMARAQZQIgQBNATGBAjgBfoEcBYQAVYQEuAEggwJ8gAAKASSEAAgKKEEBQdg3IAIRA4AGVoEAVwF8gQBXgweQgADmAzYCOIUBrwQCQb/+gAAJgABlBCAAECODFg8GQR91IgNzgBlXgQKAgBQFgBYugwLSASiDDnwCdkGCGfoEAUEAToAeWYEfa4ABYIIAPYIAXAM0IAKBAj8BLIkAFIAA54EAB4ABloEAG4AI1YIN8YAAX4ADhgEwgALIgQAWATyDACsBJIAAB4AbNYIOHAFCgRtAAXCCCD8BQoAAqAE3gQ3IAkKBgwAUAcyAAOCAACsCtAqCCr4BcIMA0QFUgwAHAlBBggkNgAEJgxmBAyQRAYQBMQEcgAIsjAFtAXCAAW0BEoIB+oEA5oIXlAgEEA0L/SQBIoQhWQIUJIEBeAEZhgEkgQeMAiIShAFsAwQhE4QbV4ECNwETgARnAwAhE4IAfYEEkAHcgAs6AR+AAKcF9AVqIRWAAAgB2IAAEAEbgAAIAfCAAAgBGoMAvwIhFoEAIIAAEAMRQZyBGBkEIRxBmIIACAQdQZQrgAH4AiEegQM2A0AhCoEABwE8gQr5AUGAGDIIAkkhIEF9IQ2AAA4GBkchISATgQIYgQMvAxchEIEY+JEiCpIAAoEJjpEiNoEQgoAiGoABdxdrDhMEBQYHCAkDAgwNARkAGw8iIhQhIoIEfwVMIQYMGYYACoAW0IAACgFsgR5MgQAIASKAC9YDKAJggh8wAwxJG4AAIQQGCyAggR/agABWgAZSBA4hDQyAAZGBBMYCDQ+ADxICCHKAFeABCIEEAIIXjQMKQQKCBrQDRQ0OgRqIAWuBH5KAARADIAp0gBR4gRSggBrSgAAtAwkhCoMgzoERfoACUAMIQcGAAF6AAtKGAMuAABgBdoIWRwZrDgMAAQKABOgBHoENdIIfmAUIA0BBkIAKBoAP7QGQghokARGBICIFdGpBCDuAAjSAAAuAIFiBAF+AACcCgAKAH0YBBIAAB4MAJ4AFCYAAJwEJgQAngAALgArZhAAnApgCggBOAZiEACeDAE4BB40AToAANAGgigBJggBwhwBJgSB3gAIIA0GgK4EEewKgPIMACQMgFEGAETYBDIAFgwERgAA/gAAXgAARBwxqIBUQJBqCAFMBIIkAUgEFjABSAZyAAE4BPIECqgEcgwBKgBCZAQyAIJYDEUEgigBJgAJ2A0EBOoAEcASgKyEdgQFXAR2AA1GAA3gBiYADeAHQgAOEAViAABOAAEKAA2sCQceCBDwCQQGAAqMBIYAKNAQKQQNrgAKngRXuAiEHgQAdgQg2gSB6gAERgQHsBB8LQcSBAZuDC9ECwguBGTQB0YEAEYIcR4AASoERF4gAQ4UAPQIMGoEAGYAX/gEFgAYIAQqAGJaAAByBGa0CQR+CE66CB+mAAh+AAXaBAh8BBYQCH4MBboMS1AMFDAKABWeAAVKBAhsBBoAAVAEKggCRAR2ABZOBCHID//8DgB6CgAAJgCT3AhB2ggsuAkHdgxKfgQChggqqgAJmBBoLQcKCAEABAoEACIMSVoAE/gFEgABagAi2gABUgQOMgAQWgQBbgACzAwJBw4IAJoIC4gNEIgOCCDmCFNiAG+ACAyCBE7EBEIEACoECiYAAKoQDEYAAOQESgBWIAwMQJYMjmQFEgAWJgABkgAAtBBJqIRKBADYCayGBADuAANaBGlCAAA4CBAyBEzCEBckCDBeACNOCAz0CDUuADFmNAR2FAzyEAR2AA3QBaoMDP4IBHoEBnoMAhoEAUoABEAEfgAEXA0GBAoAaKQFkggAQAgV2gAATgAA7AzYCaIIAEAUKdkEPcYAcVQEigAkgAWCAAE4BDoMBvQEOggG9AkEegiHeAkGhigFKgAChgAAMAcWDAjoCACGABCOBBZgBbIADE4ADqgMGIAyBCpsBE4AACQcGQRNNGyEJgADLAwYgCYIN1oAAE4EhHoAALYAC44AADAV0LwGwDoIC6gEAgQLqAQOABGABAIEHZJgESQEKowRJgANhgBrygwBpgAAMhgBpgADbAgdxgQBsiwKnAQSAAMaFAquDAEEBFoMGi4AAB4AGmYEdgYEDNYAADoAGmYADcAUTIBogG4EDbAIiDoIBIQG/ghdnhgEhARaBASEBxoQCYYIBHYABKAEOgQ6AggJKA2QiD4EABwRoaiEMgADcAQuABVqAATKAHaMEKAJYdIACwQEhghVUA1AhIoABAQEJgACbgAOXggEFASKAAzwCGHGACdIHaiIjLQABIoADBoAfOIEK4YEWDoABFYABAYkDPwEJgQEVAQmFAz+AANeAAZ8GIy8BAiIIhRV/gAj3hgEmgAAMgAEfggTEgSPbgQEcAiAGgwEcAQuBFlABf4UGaIACegQQaw4CgAWHgSOUgAl6gg/AhgCMgBAwoQCMigBlAwUgC4IJsgJBh4sDswEJgAGTAQOAAvmAJpuBBmeAAgaBADOAJYmBAJiAJE2ADqCBJp2BALsDIBFqgAAeAi8Bgg7AgBYzjQCXARuoAJeEAhuAAJqACyyDAiCAAjaAAFSCDFiACnOMAFwBGqkAXAEHiABcAQeDAFwD/wBxgCc/gCeGgQIiAwQgDIAAKQILaoACFJYBEYAD3YEFPoIGKoMBuAEEgQG4gQHPgAJigwMhhALIgAWjAWyAF7mEADiCABQELwH0BIMBbwKUCooCtwEVgQK3gABxhQLrhAMAgQasAiAPjALyAaOLAvKCADuABEMBXIME8wFwgAM+gQaZggLuggChgQLwgABDAR+IAEMB8Y0AQ4QGcYYGloADNIQFkYAACwENgwBkAciFBZGBA1cC0DeJAzeCA1UBUIADyosDNwEMgAFugATjgQM3AQuLAzeBJuahAbgBC4ADNQIhD4AC+oAAQIAp14ELUwX/AXFBDoEARwMGIQyAAJ0BBoECGgMMIA+BAGYCIRiAAJUBBoABwoIAlYIBqQIgGIAAhAELgCgPAXaCAIcBD4EAhwEMgBjPgQHkgACIgAR8pwMzgQdCggOYgABGAQCAAe4BD4IAnYEB6wEPgQZlgAVkAiAMgAXeAtA3gAAvAQyDAmwBDIEALwELgQC0gA/SgQP5AkHNgwFzARGBGscBIIEmEYUGfYAACYAknQLQN4MAGwLAAIEAHAMAQdWBB+mHAaqAABwDAkHJhQdAgBnNAXGBBj4BTIUCZoIP0oAGoYoBhoAAvIQA7oAIUqIA7oICSYAAxwEGgwDOhAdLgAfiAiAGgQFagA5dAQyBAPGLBK2FAumAKDABEIMKHwEQgQDthAcUARKBB5qBAEeACR2GAkwCIBCBAI8DECASgQCCAhIMgh3lggebAQqBHJiAAdABCoIHWoAFz4QARoYAIoIAGIAHCIQAGIITBYUAGIIAEgEOlABMgAE8hAA0AQ2AAk6AAAeBC3cCQdCDAI+GCSGDCTIBCoQrvwJEIYIik5IAUIAAyYQAUIAA+AMCQcqFAZuAASEC1DeAK6mBAEABXIMCj4EACwFUkgMkAQuDAySCAp2HAySAB2miAa6CAoeBBmKBApcCIg+DKhiCAcGCB5SAAGIBC4gDHQEPgwMdAQ+GAx0BD4YDHYIDpIgDHaUCL4sDHYUCO4ACGoEDtYAEHIIDxYAAiAEhgAzCgQMlAQqFAyWJAj8BD4YC8wHxigLzhgJYgCsQAwJBy4UBYAEPhgL7ggVpAUiHAwKIAV8DIAYEgybGhQMBgRnrtQMBAUiJAwGBAHKSAv+BAKUBzIQFKYYDB4AAEYQCJQEGgAfOggBNgArEAhcggA8fAQmAAe2CGy4BCYEcvIAAGgEwgCS5gQAIAsw3gxCpAfyLBikBB4QAQQE0gCrEAQOBANaAAAyAEJEBKIAQM4MARAFrggcrggAWgAAiAWuBBtyBE1qBC0WBFIcDBkkbgQAgARKBCvyCLo2AABeBHYmBAZiHC1cBCYILNgMJIQOAAT4DEiAFgAEtgQO3gwOngQblgQf7gQFKAiIDgRJgARCAAHmAA8aBAE2AAWKFA92BFP6SAzOAAcSEAQ6BDLSFABuJA9mAA0aEACKACFKIB0GIBA6BABaEDIqBEZ4BEIMS4QEShiIFgRQ2gAblgRF9gAFBgQlygApJATyHD58BLIABXQQQIBdGgAhVgAP9gCmBgRG8gBgSgSYJgAARgCsIhBCHgBVdATiDBbyCGDeAEh6BFXACKHSBGhKAEj+BEiaAAG8COCCBFbGCHLUDLCIFggAugRGXATCCMO+CADCBKiICLAuDAfWAALuBA6QBBIEBXANrIAWADK6CIFMBNIMemQEsgBHXgwRwgAANgAHoAWqBDNSAACeBAd+AASWBASkGSSIJGyIEgAA4AQmBAGqBAeyBDPeAKH0DBGsggQAXghaAjABPggANATSAIhiACoWAARyDAKsCCUeAGWmAACmAAniAAJYBCYEdWIENZ4EpH4ASW4IRpAIIIIIRpAEEgABcgAAWgRrdAReDES2AEuSCLQUBFIAAF4EVt4ABVgEgggA6gBKxghF2gAPSgRpygABDBBtqQYCAEdyDERiCEMIBRoEAE4ASrYIUOIEOEoEwBYEIfoAAGYABKQcgDUF7IA0bginVAQ2AAJMBF4AAHwENgACZAROAAAiAAagERhshGYMokQHSgwiwAnwhgBFJARSDIBcGGQuUCQEMgBQrhhKngAEhgAjQgAAHgBMngAM0gANCAQ6CB40BEIIatwMCQUCAAY6HJ++CC3OAM+kBAoEz6YEozoEz6IAEwAEOgSBggCGaAQSABWSABh4BDYEFcoEUpYAASgELgADJgSBEAQuADc8CIA2BC+IBCYAEEwQNIAtrgy1rgAmIAU2BLUWCF5sDCSANgAx/gQjUgwArgQAngAGUARCBAEEBCYAAFQEPgBFgAnJBgSOIgAT9gAjNgCFFgCFNggAPAwwgDIYho4AEeQMIEAOBI4GDGTmCDf2DGS4DDWoigABVgABykwBQAQiDAHOEJoqBKSaFK36BAzKBAFKDIP+CAFKDGTOAAFIFCCALSQ2BKDyAAAmBAD2CBmeSAGABDYYm5YACU4EAOYIm5wEIgSUzhCssgyLSgQA5AiAIhQA7ggAsAgcggBa3hzCagRAagAeogBnCAQ2EIgmCJYOBBtWBAYiAMqwBcYABNYEigoEAooALkoEBRIAABwFrgASngAAiAwwhCoINNYMYJIAAEQEIgABhAQqMGcCBIqmGKOyAAB+BBEOABdaEI/+AADUBGIEUFYAAEwEMgRDchQBFigAmgAAfgAAYAxQiB4AWoQEMghnEgAAPARCBM4gBAYAAEIEZxAENgAVJAQ2ABLMDByIKgRnEgAEiggAwgANvgSLMgAAQAQqCADGBBU6AA56EAYaAERaBBkWCGaOAAFEBHIEA8IAYPYIZo4EBnIABZ4EZo4AAjIAAR4sZowEIiBmjAwwgEIQZowEQgQAsghmjggAKgBmjAQqCGaMBCoEFQAEYhAC1gAAoggDZARCDAQ2AEM2DANyBBo+CABkBFIYAGQESgw7OhAHKARGHAgUBEYsByoMB75ICigEShALajgA0gAIQAhIQggX/gAf5AgcLggCYgCi2gQbegQRJgBgtgSVlAxpBfIArbgEOhCPzgBBTAnEbgilIgQBMgRD2AwdLG4IAOgYJIA4gB/yAOmaAA8cBEIADFwILIoEEAocX2wE8gAAHAQ6ABceABA6AAC6ADPwCIAKDAC6CBk2BBluDF6qBACyBBluBBFODGbKACAYBEYEk9YEAHIIFKIAHO4EF24EFI4AMrYAaOYEf2gUYdHILCIEE6gUFEBALS4AZSIEXDgQEf0F+gh43gCExgQZmgQB7jRd4gAAdgDOcgwAXggZyiBePgRj8AR2JF48DIAERgAengQCcgADkBQAQAgsQhAAehBfSAUCMF74FDxATC9KBGSuHJUObGRiBCQyhGRgBtIcZGAEmgQ5DgC0QgAEFgApqgAYFA0giBIATuANBD0uCGwwDQYH+gAVDAXKIGSaCGR6CGSgBIIEAKYMZIYAARo4ZIYYAFI4ZIYAZXZ0ZJIEbaYsZJIAAtIoZJAHEtBkkAkF+jAFmAXGAAWaLABIBH4AAEowZNgEGgBk2BIBEASOEGTYBEIIZNgEXhQFCgxk2AQyEAYqEGS+BAm2GCKeCB1oBA4IHWoIOVAHAgwcYgAAHgRybgRj2AiEdgAAXgRlTgBkTghlTgAe0khlTgRlrghlTgxk7gBAWgxk7gggFARyFGSsDDiESiRjzgRSCgBlTgiGmpRknwwACgAHmgAG7A2sOH4IZZxszNDU2CgsMDQ4PEBEDAhQVASQAJhcYBD4/QEGEGWoDCwwkhgAKgSRZgBlsgw5aghl2ghopgxl2AQqBB/aBDkmAABIBDIAMGQEygwAKghZ0hgFiAgwzgRBnAQaDBQmACgQBN4oWMgEGixYyAQaBDGKBELGBEP+AIPWABKsEn5YCR4E45oEAWwEogwBZgBBNASiBBf2ABMKAHPyAAAICECeBAwcBHIAPLoAALgI7AYEpLwEQgABKBEECECeCIJ8BtYgXUIAEFYAAYgEzggCrASSBNr6AAlyAEFeAAwSABT0DdEGAgANugi39BWpBH3BFggMhggjBAwBBuYsMaIAAQgEHgRafAQiDF9EBh4AO0I0AHgIEdoEDxwNxIgmCDTiADUYCB02CAMYCIgqABwcBCoAMXYEpvgIoIIAhFgQFT3ENgBaXgAWmgjq4Aa6LDeEBA4AUYwEyiwFGATakAUaCC9aABpCCEhWTAKuAAbYEB0GAwIE9nYAAHQHYixL5gwHTASSEGF+BARiCBDKBNo+BADaAOBGBBGSBNOyDAAuAAXcDOgAIgAc+gQArAjoAhDv/gQGagwGPgh0kAwJBtoUTRYEIwAEGgwDbgxlvA0UNNaUA24gAmIEOToEMtwMtABWCJPSLAJSCCIaKAIoBBIYAigG3kACKhQFlgAwMrgCKgAD3gyK8ggFzgSAWmQCYgQKskwEiAbiLAJiBACSAPBsDQYAIgQGnAQeCERmFAKmBAASLAKiABLyAL4CKAKiDGqKCFq4BNoIamIICfYATlIEAvIENJYAP34EI8YIDV4AAaIEAo4AFvIUArgEogACugBvykQCuAgwohQECgQAngg2oARCAABSKAdQBMqcCr4AICoECWoADh4ADj4A8y4ECc4QDlQQYdnJygwPpgghuATCAAScBvo8BJ4EQVYMIrYEIloAC7I8O8YARF4UO8QRBAiEXgAEShgRKASiMAGGDFHsDCyAdgB8UAg0vhB5PgRohjBoGgBhuhBoGAQ+KGgaFAOyGGgaHAOmkHk+BHkeABjsCpDyAAE+BDG+BHWWCD+7/HlyXHlwFqDxBsDyCJqEBzYAABIEACoACM4keXYAAGIAAEoAeFQMUECmgHl4BrIAAUAHNggfagikfARCJHl+KAEuAASiCHmCBAdIBqIEBK48eX4AAQoceX4MXxYE7jIAR8AEGjR4bATKfHlSTADkBKoEAGYQeVIAZlrceVIAATgMGDDCpHkoBBoEAfZMeRAEGhBizAgwtnh5AAQ6AAAoBDoIeQAINLIANIZIeMwEMgA+mgQApAWuAEDyLHjOBBBOFHjMBJ4MEC4IPyoAECwErqAQLkh4hgTmHjx4jgAGbAWCAAD+AHiOBAYyCHiMEBUEeSYEl+wFNhQfBix4qASeKHiqACNeIHiqAFZqDHiqAGWGCHiqDGCcBC4MeKoIcm4QeKoEa440eKoBFTIEeKpgEJIAbR6EEJAEKgQBpgAS0gQBpgAAMjx4qiwJ9AQiAAMaLHioBFYMLkYAAB4geKoAADoALnwIhDYgeLoADOgIiFoIBJYweLgEmkR4ugR5DiR4qgQHhgBGrgT0piBrzARODGvMBGIYWcAEGggEFgRdSARODF88BGYEXT4AdNIQXz4AAvaQeKgEZgR4qhjOpAQ2IASaAAAyFHHIDBSAKggEcAiAKgwEcAQ2LHiqAPQqFHiqAHbyAAn2CAeIBCIQXCIEUcaMX2ocAZQMFIA2eHiqAFOGAAgaBADOMHioBBIIAu4oeKoAgB40AlwEkqACXhAIbgACagBEXgwIghx4qgBnHjQBcASOpAFyAHiqGAFyCHiqAEkSEHiqAA04BC4AA8oEVnwENmx4qggglgQUNhQG4ggZKgQHPgBHwgwQmhALIgBLdph4qASWIHiqBAuuEAwCIHiqHAu6MHiqCADugHioBHogAQ4weKoIAQ4YeJAEWhx4kAwUMK4keJAQEQQZJgBGXA4ICSYIM3aYIsIAFjAIOaoAFFAFrgBo3gQV9AhJrgSgDgRaRgQ7CghaJAxwiDYEXF4ADkoEWwQQgaiEhgAOXgAAMgxtmASKDAA2DA6QBI4EACwFUgAOkgAAHA1AhGYEABwFAgQLIgQ7QAQOBAAeBFheAAAcDMCEkgga/AQ6BA3KFBrSAMJuAAAuBPrgCCGqAGKGCRckBcoIKeYEDTwILIIAroQIgI4ID6oE9DIRBLwEGgQP0gAzngRl0AgR2gQQWgRuUggHKgBtZAy0AAoEZSIEjIoAcU4ADBIADpoEK8QEGgRshAQmAEhWCHdGCAC6CBO2CA9OBEB+CAJiBIYCBAt2CBk0BCogAqIIAnAIIaoAAT4IAeYABAgEEghqmgTyKgBoEgACJgTF+hADfAQqGAv+BAAuGAN+BHPOAANiBIeOBAOYBC4IEyQEihADfhwDbAQiDG+kBCIEDFIIA24AWuIFK9wF/gACWgQC7hEUegRt/ggOIiQNsgQXvghDsgD8SAQOAGuYBGoMAgQEDhAAfgS7tgQA4gACHgQNhgAC3gwBsgwFHgAEighuAgwDaAWqABVgDDCAfgBjwgxs/gBo+gRkcASSBGzyAAdABxIEbPIAbOoAGaoEdGYEXa4EBVAMOICCAACiDB4KAAIkBC4EFmQMOICGDABSBABGAAESBIhaBGQiBLWeCAbKCGvqDAbKCJUSCBpCBQrGBFawBDoEaioEAfIAUzgIiB4AXcaIANoAWOoEEYIAANANrIQmBFnYBDoEET4EAhYAAB4AUuYEZh6sASYABKwEJgQRuAwlBA4EXlogAOoIBtwE6gAFnhQJ/gBT9gQU7AQmAAFWAAjqBAFWAAAeDB5KAFVGAIMKGADwCCUGAQciAFsuDAq6AAJyCAG+BI4ABDIAcS4AAqYQAKIAADIQAZIIACoIAZIIAVoAuT4MF/IEAcoAQJwECgEqvggBmgAJNgQAqgAA+gAWPAUGCC26AEB2EAGaAAOEFLQAEOgCAOqGAFASAABSAAo0BCIMeHYAeG4EBAIId3QMIDB+BHsCBAhmBAqWCAh2AEOGAAh2DArSAANKCCKeCIUuBAf4BGYcALIcDI4YALAELgQnQgiGTAw0cGoAhdoAAFQEbgQDyhgE/gQMegCAsgBsOAU+AJNKAInGBRAiDKKqABPMByJEjD4ADpIoIHIEeLIQjDwENgQNNgAZtqwgcAiANhSMPgABAAgAigAZLiCMPAQuCHV+BJjGAAGmDIw8BE4AAlYAANYMf8oEYgwEFgBvMgBqYA3EgC4gjD4AKDoUf8qUAiIAKLIMDnQELhiMPAQ2PIw+BAFmBARuMCKwBDYIjD4IUw4YjD4Ao2AEIkSMPAsg3gwAblCMPgikPhiMPggSDgAAhiCMPgE4JgQqjiQGGgAC8hADuggqTpSAOgADHhADOiCMPAQuFBI6DIw+AARWBAOaCARWFB86AAjQBDoEPNoItz4si/oAK7YEMXIQDYYABqoIUX4EePoIHUQEKixBlASSkDFqAHwYCIA6CPQmMHZuBRLMBIIJFh4AZO4EHXAFGggecgBHOgSDHgRD4giJGgRGLgQJPgAG/AQODFGGCAJaAADeABK2AAl2DABkBKIEWV4MUcoQQToID2oARQoERQIAZyZwQ6YIAZwIbRoAAMQMAQeeKCOKABVUBEoEs7oMmkIAAEoEWqAGAgAS3AXSDACaTEMkCvf6CHleCE+wCAHGBR/+BDhUCDB6GIISABHKCIGkBBoEBaYMAFIAAZo8AHpEAMoAtyo4AFIISxwHOhSQ4hA8Fgw8WAQaCLAKBJDgBCoM3joMOnYAA2IEANAHPgwK7gRZ7hyQvgAECAcyLJC+CAZIBVIADV4sCvoAcOgIgCogkL4cERKQqioMDp4EdGIwkLwLIN4MHGYAcjIgEPYokL4EEPYAZxYQEPYEHvoEeaIUEPaUAgYsEPYUDW4ABIYEILoAFPAEKggChgB0vggN7gSfPhARFiQNfniQvggFgiyQvggQbgQ53gRBpkiQ0gAFkAiALhCQ0hQQmqic1jAQmgyQ0hAQmgyQ0iQDFgQ03gACEiSQ0AQ6BNTWAKX6AAMCHJCqCA9GBAeiCJCoBBYwkKoII7o8kKgEShiQqgAoUjSQqgQBEiCQqgAAiiiQqgSIugCD1gyY+hyQqAQuDJCqBAB6FEUGJJCqAD/eLCLGOJCoBDoEkKgEOggBNgAUThiQqhie/iANggSkGjQAUhyghhwAUgAA8hQHzggT9gThtgQEDgSvPgA1nggFVhgx4gRJ+AgN2gCFugx28gAWWAWuBEYEBIoQMngETgCNogAh0gROFgQA9AQWBTJyAE4qBA3aBCDMBBYIByIEMposbGYAABwEEgQR9AUeBBP+EBraAQr+BEt+DJKcBBoFUmoMVwQJBuYcSlwEUgAkUgxbyggFegUXxgSzagBKWggHqghZ2gB+hgB93gRtxAQ2EAAoBGIABnoAABwEUgQHEAQWBAgOADNGADKuAAZaAJEyBGriAHTkDC0sbgRLQgAAmgAoYgUSQkBjMhBbrgRL7hBeWhRL/gQD0AUSEEuyEEvqAAF2AUSqAAL8BuogRLQFEhhf9gQDFgQa0gQaohA93AWqBA80BA4UAx4EfrIFE1gEcgVWbggK2AUSACHiAABEBIIEkc4MSC4EAdYEIMwIgA4IU4YFRyoECQYEBGAJJG4ACPpYYaoYAygEFhADKgQB/ghOugA40gADCgCDkgimehBfGgR4Ygh2qgADGAbuSAM+BDNOFAM+CFNmVAM8BJI0AzwEo5ADPgzYliQDPgRzVAkG8iQJdAQWBAfWCBM2HGfSBLvSgCEWDAJyFAJGAAuIDLwEcgU7wAwBBmosJgYIXwIcYnYQaKAFBgDowgCb7gADwAQmDG1GAEhiMHMyMGIKBBGqAFDmCBGgBFIAACIoI+oJGeqAI+oEIpIEjc4IDkgEggVLLAwBB0IoFFYIApYAF6YQXyYIAuYMHo4AAGwEWgRaWgQCpgywOgSwfgUAJpRC7hBN5gQVhgTTHgAlfgVNMgySngShjhyhiAQiBCvaAABCJKGKCCw+WKGKAAG4BOIFKtIUoYoMokI0oYoAAmwEsgQG7ggYvgAbRgQfZAQiABZaFKBWQKGSCKAcENCIGaoAAJwEJgAAngU8ugCWJgSWNAUmBIagBCIAAOIESw4IoZIAAI4AFIYAQBIAmeYEoZIAAlpMoZIFO84AC74IowYsoZIIPXIsoZIAE3IMnnQEEgQGFhChzgEyChShuggDOlShphQKmhwrPgSEqgACmgwq4ARyBWaKDBweBCtSBEQ0DCBAngySPgQALAigLgQFbgQKOgAAHgijxgQXauSi4AQWAKLgBBYMouAEFggCVARuCS8kBHIYouAEXgwJkgyi4AQuAKLmADMQBEIMouQEXgyQjAQeHJCMBJsEkIwEKg0DqAw8QP4UACwFxhwALAR+AAAuMIosBCIAiiwLXJIApQoEhuoFPOAIQNIEiQYArJAIAGoIC44EBY4QiiwEcg03ZgFWegwCZg0qfgQDqgwE0BQRBmgVHgCtdgRpgAYeBA4uFKZGAJteCAx6ADEiAAHmABDCAAXiHA0KBAa0DABA2ggApgwcfgAIdgwE5gAdfASiFRpUBBIBWdYFFNgJBd4MkNQJLG4EP3IQAEAcDQQRKG2pKgAC2gBBCmCI/AwRBKoEQgYIAqoNEToAEcwELgTCxgAB3ARiDDqYB8YIEpIMwDgMwQQyAIUgB8IEY4IEEOIMAsQGIgACHAUqDBgoChAGAGdYCAkiAEoEBwIEIAgEDgBUKgAAMgAJHAcCBUPkBBoACA4MbX4BPNoAAKQIgcoMJdAFsgSUUAh9wgEChBEEfcxCCCGIBbIIX/wQALwEygQAQgQAJAzAQPIEBSYQNAoMFQIIAm4IBLYEBOIQEc4EAYwMEQTmDUfqEBXiCAC+DBhqBGYqBA0uCAHqAFVsBH4IOl5MAHAGLgRxvlQAdgCEOhkzogyMXkwAoggoV7AAcgB77gkjPggGQAQmAAeMBQYBGy4MDzIIBroE2lwICSIQBjpEARgEggBKFlgBigQfVjgF+ggLUgwKigALmgATxASSBCv6BAyaADEWBHtiAC/OABRKBCq+BBPaBAvqECgeCAF2CALKABLGCAH2ABpwCR0GBBGYDCBtyggC4AQOAAAiCXdOAAAgBEIEITQIbcoIAhIAAX4IG1IUATYMcQIAKH4QASYMAqp4AJoIi0YMAKQMvAQagAE8CLQCBE4mcACa9AX2CALeCRYWcAI6CVlmBTU6BCvShAQyZACaIAQyAAcABC4ABs4IYxIAEG4ADQ4EGn4EAN4IDUoIdZYcKQwEgglsygwOBggRbAcWAJpkGBQIJCQkDghSLAduAMFmBUaUB54EMLIJaAoICLoIoTocAxoAHbwIvAYAG6YAG54EOLYEAbYEEaIFD+YImgIJPvAFPgwPrgAoXghm4gADSgjGCASCAAL+BFpGGHtCAEbuCBzaCACMCLEWBBHgBT4QZlIcA0IAARIAGpgFrhQDTggBJhBIwhgLcgRWlgQwTAQaBBPaDDvKDAuuDQLmQAIkBBoUAhAEUglKdigCHgAClAU2RAIeBAL2GAVqBAVKCE+KGCbyAAD0BHIMGEQEUgiBzgQAThAEjgU1PgADvgkaLhADqAQePAGOAGPeAABiFAGOGBTeCAfuAAEqEChWBIPmBC4SDAQqEAiGAEzyDDAaBBb6EAjOGALeBAjCBDuOEBQ6BAIGDBg+BYPKAGBqBB2OKAIaAABaPAOkB24IA6YYARIIre+MA7IArFq4A7LEA6gHniQHLgQNXgQDIhADUgBdjgh1RhQCpgRPDg0tnATCXAImGAB6aA8uJBwaBAIeNBbiBKUeCAs2CNmaCAAqCD66CAAqADAaEAAqDAI6CK3aAADgBdIFF84FJqIED8oAIP4E0NYQIV4IKc4EE/YMHFQMBEDWCMCeFCOCABQQBAoUfnwMCQZSBESaDRHaFAFcDAhA5iABihBUJArQtgwxCgQmrgAAdAVyBYO0BToFkWYELnQIDaoE8xIEADAFsgAOmBEEBEC6DACYBbIId8IAGfQMQNkGABXSCAAuAA6MBG4MA1oAAVgFggwBAgQArhgHzgAANAqAtgUiugAFNAqAtgUhTBCgCmC2JB3SwAB+DAbCBEg+BFD6ADCuAIAmAACSBHxWCADSADPGAEk0BdIQAt4EPK4I/IIIAToEABgKkLZsA+4EQsYAB448A+IUA9IJhNYIBIwKgLYIObJ4BRpkAToACNYMBRIEBv4IjWIMhfYIAy4BF/QKDAoIVWYYBYwFsgyVogQHaAgFFhwAlAklxgA+VgDioiwAqgSFHgQ4ygQCVgBbHggInhgICgi3iwAICgQLsgwEMhCrJuAEMAQeEEWKAAK6AD7OCET+CAO+BWueAMvQBAYFJ0oANxoEV44IPA4Id/IYACoBi0YEzCgGCgRtkgAkGgBFoiQACgAT8gBvygBE6gR4vAQiDWXWAAAyAADWAGfSBAAqBTyuDAAqAAx6BMjqAAAqAC82BY6WAAAqAIKKAXYaBAAoCB0eBPR2BGMCBHoSAE+mBFdOBE7YFA0H6AUmBHreCEVuCP8iAFd6BBAOAIsiBAAqBLMWBHMwBCYJN1IEcrAEJgk26gRyigh3DgC/CgQAKgRDHgSJ8gQENgAnLgBRfgADUgl4Hgjl7gQcFggHjgAMggQMJAQOANLCAL3eCAHCCAyyCAyqBZB2HC3aBACuFAB+CBNeOA2qOAB+BAFqACAOCBaiBG20ELQCQIYADdYASjQJBhIEffYoDe4Au74IuRoMCfoER6wKIE4IAHAGIgCTjggKogicSgQOYgwyqgwOYggKUgQB/gRYUgQHmgQQ8gQNUgwnJhgDMAQOMAK2GAB+CAE2OAMyOAB8CIAWBAB+CAYmoBDaEAJyFBDeEACy0BDeAHeiBAO2BTj8GQQxsQZgggGi3AQCAM/UBC4AATwF+gBmMgzFyAZqACWiBV9gCQX2ANpSBNKSCADwBBoExVoYJ5IAA3oAExIUGCYALCYAKHgUAAQEBAoJU3IABewK4LYMDoQG8gAEKBXRyIgY7gAASghDCAwNBDoEy1JQLLQEGlwyqgREjArktgwyugFXkhQBdAmt2hABdBANBDWuCEbuAAt+AANEBNoAAHoQAcQEKvwBxgCgygQDAgQBzAkEJhABnAgdqgBRDgQBlAhAtggUQhAeaASuBT62CAaqAMZuBD8SCZkSAAA2AFxmFKHuBIluBDQqCTg6BAfyFNAKABRiCAAiAAbuDKOeGED6CACKCB7yDEJiBJK6CBVcBGIECDARMDQMagwhCgQHcgWdXlQDVggOQhAAqlQAjhQhsgA+ymAAmggAjAy0AM50AI4AAC7sAI4cAjwEKnwCPg1EKlgAjghUlgh/cgGp4AXaLEJCDAyoBGIFniAFKgwbIgGaVhlyIAkULgjTzAfqBJyQEQXsLHIBP7og1CwEQgAxhhzavArsBgDaMgRJwixL3gQ63glZcmBL+gAAgAUScACABQJwAILATXgF9ghJoAfGAE/0BC4FQ1AEBgADEAQmCE0sCbBCBcHOAACcBbYET6gcQQAu6CQEVgTXcAUCAJWSCBtICBkGBOZODDdYCIAeBEoICCkGADTSCZvYCdGqCBOWABPCAScuHBPCAABqAFvmCDXuCV76AF9cCIQmAbgwBDoEj+oFA3YIAQoAQTYIAQIEKeoAADIEkY4EAMoEkJ4AABIFOSoAW2YEZpYAlu4EsBgEQgB8JgiomgAA8gi8UgAA8gjtVgi8UgSNEgCG/gQAdgUo2hAOKgySKhABYgRuOBAhLGyGAOd6ADFEBAYImL4A8H4EA04EAzIE67YIAuYIAQYIeXwIgaoEAZQFrgAkAAgBOhGhRgAALgAIXgQCxAkdygBkegjGogCLQATuAI7KDAFKAAO2AAK6HAS6HASkBIoEJPgEKgwCfhAExgABagwEzgWEhgixSgAANgS5jhQFBAkETgUDJgE+KARWEBYwDAA4CgAuPgT3IDCESQe4IIRVBrgghFIE6bQF/gAARAvANgAARA7ANIYAyQQEBgBatBA9BCUuBaXuAZVyBYOABAoAU7QFxgGnDgARZAw90IoAHPQNrIReDEfCAKZOCDWSABIOBCiOBY84DdCEYgAosAX+BEcECIBaFAMKARQOAFDEBGoAyhgISTIRCNAHggjznARSBRSOACimBACaAQWMDBiAVgQdoAwshGoEk7oAIXwIiDoEBYIApw4BGaoMkzAIgGIIOLYEeZIA9EwEHgyyKAiAQgAFJgCUCAQ6BJMsDGSAagQP1gSZCgl+oAwFrdIMBYoE+EgF2glxhAQeAWWCJAhOGAoiAAbSEAoqAbMWAIcyBUswBB4FxF4AAy4FRjQEGgh9cgijBgEx5gwGwghzNAQyDChSCRUkDAiAXgCBFgRpQgwElgQAYBSAPIgkhgDdshwDLgQRQgQC2gBlMgQC2gRVPgRPWgD8kiACygWIHglmngD4JgmzwgwCYAQCCbV6AAJiCAqODX+8CIBOBAFaDWyCAJKGBAmMBDoEJ4oApA4YBiYQAB4Ifk4AApYEg3gFGgADKAQ+AbNeBPZqDGRkBS4Il/wQgDBsigEflAQeAALIBGIIBegERgQFNgQGTBAZ0IRCCL2eBA3EBDIAvvIEhoYA9cYEBToJKM4IC/IAFUAFKgW2bgDzfggJUgQJNggIgAyATaoACRAPTBkuEAlsFE0HRBEuAAl+CFEqAAtqAJUCCRa0CIA+BAReAAtWDCSCAM7WAUtkBdoEBMoAhOoED0oEAbIECNIMDrIEDyQEAgwMPgT5vg04QgwMdhwOTgAAYAQ2BAAiBAzyFJ0EDDgsrgAFfggHLgATbhB/hgQSTgVzwgQAHgmW8gGr4gW8AgwT1A2BB1IIE9QLEA4JxZYQ8goFV5QHVgRgkgRcbAdWABnSCAAeDUS8BAYEdcoMAHoMlpYAQVIEmy4ADNIEOkoFRBYAcz4EoKoEMDYM364AOYYAIxQdBoIbi7X5zgiASAgFxgXHngzBohBwSgAoagAoQAcCAb+6BABaCIaqBAGiBHKKDbyABc4Agu4FrpIAuKAF/gwKuggDlAyADc4InW4FyYYAAPoEQSIAAKokA8YUCXYAAQ4AYjJQAM4ACoQIIdoEAHoACwYkAHocAGYAC4ZMAGYAcDZMAGYAQuJMAGYAHMpMAGYADIZMAGYA71YoAGYIA4oAdUIEA4oAbRIIA4gMLvQWCB5aCA9qAACGAPKCEXiGBCviAADGAAPuBA60E8f8Da4ER+wRB8P8DgCDEgWqOgXKlgXaGA4CAPIAKF4AAW4IAGwMgAHKBWbqCdRKBHpiEAXaDAVSGAFGBZsKBdD2CAXGDBvSBAGMBcIAAUoEHc4EAbYFjLIIAUoAAUIACKQLbAoEMgANBsCuBD3iAbEmCDjeBAmeDAE2DAA2BMtuEAAuBDZmEAAuAb0qFAAuAALaFAAuADiGFAAuBFMCEAAuADtCFAAuBDUyEAAuBae6EAAuADqqFAAuAQOOFAAuABAmFAAuABZiFAAsBDocACwEPgQALgnWugC0IgiAsgCGJgQR3gwD4ggLZggAJgQGkArArgwGlArArhQKIAQKAAr+BAVIBEIcCyKQBUoYAWoEj/4QBzoJsS4ICuIAADYQAC4FmI4QAC4FxyYQAC4ABMIUAC4FooYQAC4FmXIQAC4FsqYQAC4ABMIUAC4ABMIUAC4E/YYQAC4ABMIUAC4ABMIUAC4ABMIUAC4ABMIUAC4UBMIACZIMBDAEQhAELgRezgS9aAnRygAFEAwsLkYkJeoARooMInocJfAEGiAl8ggUQhQl8gCjFhwl8iAjyhwl8ggBCgTpeigl5gUV3hwl4hGZsgXA+giR1BEHAAjaBDMySABeCTJKBFZGPCa2CB0+BJFCjCa2CCR2DCa2ICjeHCa2ALDyCAFyAbpiECo2CdCiABh2BCYyFLmiAEDOICa+ACMoBToEINYBbzAEggENVgWGnhAmyAg0CgFXfgSjkhgmzgQiEgD5BjAFnhwFihURoiAFqgQh/hAm1ggAXASCBCGuFAI6CBbkBFIAGzwUFIhMhFIwJtQKBAoAJMQmgDyEUQeAOIROBCbWBCUICoBCBABEBD4BaUYAHWAENkgmzAgQagQAbAnQigEraAWuAMiCECbQBDYIXHIEJtIBUJYAAIYAH0QEWhAm0gACAAiAVhQDDgCvAAWqALtMBGoAf6IADdoEGqgEOhAm3AROBABOAE4OFCboBDoABdgEUiQm6BA9rIheBAWuBCO8BD4MJugEHgCKBggs7gijzgAbZgQfmAxggDoEH0gMYIBeBB+0BGIMJugEGiQm6ggFpgQfJgilNAiAGjQm6hQLGgAG/hALIggkiAQaBCSIBBoEJuoAAz4FB9IM5f4UJuoF2v4gA64oJGAEZgClKgEaAgAAoAQ2NCRgBD4AITAQPGyIPgRq3ARGACVaHCRiAAPGACvuADKqCCRiAKcCAUESDMYCCAKyBVimDAmWAUdSBCRgBB4AkUoJldYIJFoAj9AISaoABpgHUhgkWAxJB0IIJFgEHgFQCgkX7g07lgE6/AQ2EMO6DMP8BEYAYfYQJFwELgAp+gAM8gQBrgAGRhAMWggkXgAM1ggyqgSzbgQAYgQKKgAKAhwL8giXJhwkYgQVugTXXgjBOhwqoggGkhAqohgp2ARKECnaCNjGCCncDCwuqgBHygQdSgRY6gTIzAwFBnoISRQQAQYgTgAASgAJJgmzJAkEegwAVAfyBYfaGABUBE4J8a4AACYAAWIMD4YgF0oABMAM7AZSAbC2BDqACsC2DRRIBqIAACIEAEAKgLYEToJIAOZYAGQMLrwKCAKyBD++BEi6BDwKAEkABBIASnYA8xYAAEoF04gEEgxKdgg8ugRnIgxBAgkQpgBBAghPBlAAcgAb4gxIsgmLNhABdgBKdihKbgTJGgxI0AgAQgEX5gwBKhxCmgwBKgjValQAchRELlQAfgAL7AXODFTCUAKiGHhODECKEJI+BD+oBEIA3E4MANYBtRIFAYwGngBPQgkdRggDMAwFBCYgBG4EBWIRtkIUA/wG4hAD/lQAgggEfgxK9gBKvmQAqggBKgiIggwGZgQCAgm76gAH7gQE8ghRwgTkkgQA6BMAtC6aFAKmBAeCEAK2CSie8AK2FAIKCTUqBClABSIJtXp4AVIEAP4cAuoAKgIIB9AQLC/wKgGgFgwarhQX4gRtcgxJugQwyASKAKw8BLIETvoEKnYEDVAcJQf+A/59/gjSsAQaDP3qBDB2BB0CBGVmDBzaCIyOABTaBGWyGBmKABxWCAuoBAYFwOgMvAbyEAAgByIAACAJBIINYfIAMh4E9KIAcroAMW4EAOoAhtIIRcIUWKIEYFIQpGoAOX4ANaoIpAIEBFwWYFmoQL4IACgGkhgAKgACwgQDFBJwWEDCCABCABAKBABABqIUAEAGwgwAqAkH+gYAdAkESgQYjgAECgDVggQZyAQKDL7OCN50B8IBBxIMA2oMF5oYyD4EATgEtgQAygBe6AwVBEYABgIEEEQYoAqwtQQqAIsmAWQ6ACm2AJteAAAqCLFCAABuAHKCBeOCCEYaADXyBHpKBGrSBTt6Aeq2DHmiCJjECECuBAICCBByDdcGAAnOAGA2EACGAFVOABCeANWsCciKARriSBC2NAhGJA8eXAmGBOC2FArSEBC0BAY8ELQJBoIBBjAMaEDGCAoeBJhCEAI2CdwKGAIeEAJq5AI+EAz0BDYEqpIEAmoAAlIIKi4Q3AIRMRoEAk4EB6YEt9gH+gls+ggHogUlaggEXAQyEAJCBIYuHATK4AJgBBYIH04kBKoJuggELggEohABngWwKgAKxgH88gwChgACKAQGHAIqAYzDCAIqDCF2WAIqCAGeCABKHAIoEBkH9/4MBJYIAkwENhwEdwwCTkQEfASKAPaKCAksBDIIAmYcAb4UAGAEEgACfgwHKggQ0AQqGA5iAA+uCE3UBCoJCtoEcbooDk4F/a4YAR58DBYEnV6AAwYEZz48AvIgDB4kArIYEDoEEcoAAkAMJEDKFBHCAZ84BB4IADoEgqQExgReWgH0YgiGJBywLC5YLARKBDT8EIGsiD4AqpIJ1Z4BhrYIXj4INCYEX5oElogEAgk1NAtDHgAhxAdCCRymBAAQBSoKDbwNB2CiDDtoC3BaBVeMBf4MVFIIMF4Fqa4ESWoBXbwEogW3ZgBT/ggDagQCkgFd8ASiAAUuFOeCBLzyBFG+AJjmBVP+CcE6BQtiAH0mAgh2ACPiBAMGAfvuDEqGDBPeCHB2ABO+BNG8CCRuBFoSCbjKDBP+CE5+ANG2AACMBrIEajAELgXQrgwBSgB4bgAG3hQGiAdCALZSAChWEAJCCFVSEcM2GAHCAa6GCLFeCCgyBBgWBCduCAXOAAV2DJiCABmyCAPSAB8iDBrkC0CiCABGCAO+AAISAAF2AABUB4IAMBoICQoIAh4JF4gLgFoAAEYAfRAIQM4MAjwHUgACPgjGlAdSFADKCHwiCAJeABm2EAP2JACaFAB6EATSCIYKGAOoBBYMK4YMMcYEA94INhYN4QoAMKIEfuYEWFAEEggAKgBokgR7JgADfhCHNgQr7gC1NgwsCgBw/iACthEPxhgHcgCshhAaQgwCcgACOggCcgwHhggDKgw8MAbyAAieARc2BGfqAcEqBAmYBCYYCcgEQg3wZAQiDW1ABBINOpoJD74I0hIAKRoI8T4IsCIUcOIYUEYIx1YEMrYMAhIMBYYUK94AxP4IJ7wHUgACtgACUBrwETBshEoIHboIBzoEjGIAv1IAx+IEvNoQAPIEktYAX84A0QoAB6IBSZYQ8YoFDwYEANYEHJQVMIgIbIoIXgIGD9oEqEYEFdAIgDIIV/oIX34se14IU8YA+jYEEIIBIMIFWRIMAbINsZIMHzoAAaYAAfIABpQMQamyDB9GANB+HAtmAQN2AFkeAAIaAAcOBACCDAt+AAMqChuKBRyiAAHaCRNkBAYICg4AB4IEK84KAvYE8noIO3oEI0YAASIE6poIOOoNIvIEBHIEArAECggImgl+igQ5egg+4A0ECSoEABYAtGoAAO4EAXYEAlIQAboEOP4IC/4ID8IM4LIEtKYQBR4EBEIE+HYIJWIAfxIEBQoAFfIMFT4MA9IAAFIEIVQIFa4QA8oAR+4UDbIUTBYEK4oAMuIIWuAMAQbqAAkeBAU+BEJCEAhyBGvEBf4I6nwIASIECxYIEioINWIQbhIMNBoMAgIEFBAEPgwJJgS/RggXIhgGkgoIfgQB8AXGABdiBDj2CAmgBS4QD6IQ4NIITv4JD+IIAnIUNpgEPgA5XASSAFa+DAF2AhreBHHGAbuWBA3yBABGABt6JAraBhVKAA62AA1KHAOsFC7YCAQmABxmBOSyCgmyCAsaABtECOwGAP0sBQYACQoAE7gRBB0GKgGbHARuALHGDDkaBHC4BCoE6ZoEEhoMBAYJ1voEK2ICGroADHoNCyIIaBYAZooF5K4IW7oGMzIQC2IAv24EET4EFjgFLgRBtgAbOgAVegSe5gAQHggE9gxotgALtggDHgh/2ghYqggcdhQAlgHDohgLzggLYgAtugRCLATuAAAeDQvqBCuYBCYJ1KoEAHQHAgwAdAsAVgweagAASAcSDABIBxIBivoARWAIKQYA7hIEEtgRGIgMbhQD3gCTwgAMlARuEAQ+CATgC0AiAATiDDESAJPqBAF6CCr2CCY2ACr2BAHqDBpCAIryAEYeBQNGCekOCB7YBL4EFDIEANYFDOIIikIMBgIIAkIEOsoIcfIQHlYEhwYIPJIAHp4AzgwIDSIcH8Y0OgokPI40AHIgH8YATp4UAXIAH8YMPgIEFqIAU+4EMeoEAC4MK7IAk7AKQIYFBcgJ0IoEWpAQvAYYIiwCmAoQIgDawgwBLAQeAAKeAAjaDCJmDAKsBB4gAq4EHeIEAj4JUAIUtQ58Aq4BY14UAYIAAq4MAYIEkJoEAq4QmF4UInwYJQRxrQWyBF7WCf1YCkB6BOnCDAIyAAA8BoIA0hYA0mYMAkoAaCoIJSYBJAocJ/40AhoIuOoQAHJYQcIwJ/QEEgAqSgzSVhAChhABqhAAVhQCrgACCgQB6gQq0gQ1jgCbRgUgggA4SgR8eBIECSRuAAXgBI4MBeIAW94AC4YANoYMAt4ECGYBEpokRN4AAfQEGhgDakgCupBE6hwFsgADHhABggQe6hgFsAQaGI9oDCUEEgVsjgAjFgAFpAR+ADLCAADuAAAsDoBwigACLhAKigTSwgQK8hAIVgwB/hytZqgIHgYAYiwFnjwCghwByhQLShgCwgRzFgBhsgiF/AqAtgUNygALeAy8BgoGGLYJ82AMvAYCBcryBAD2EAhSDXbubA2+iAiKBETCFALiAgMuEAQ2AiIqDALaBeM2DEKEFswsBCn+DBWuBBY8BIoAfEIEw7YAs9wEbghsvhAV5iwV1gI/CghzcgA6LgQcVgALygU2VgTgkg00Xgj+EgmoygIMmgStDggWEgwVxgQs4gj3SgBVJghVjgABmggTFggDEgATFgR1CggSagQJ9gAFbgQJ9gD2OjAElgAHyAQWIASWNAeKJASWNAByIASWAXOCEASUBBYAB3YMAYIGCjYQBJ4EACwELgQqGgSXyhR4ngRXehxA4hBRUgXrdgRA6gQX4gAD0gRTlgh2whQDmASKCSSaDix6DIeSCA0+CAqaAHluCAfWZA02iArKCI/mBBWCBAMCCEhuBbjSABByDAfOBG0GGD86CfFeBBraDAIqBKraBAQwELwG+FYB2H4YEs4kDRsAAlIEEeo0AlIAF/IAAJ4IBZAEFhQ83gB1chFsFgSoXjQ8zgQ4TgQBtggasjA8zgQJrgi9njwHtjAU2gHcFgyfhgVCZgA/HgQaFhgBxhAAagCs/gQAagkrKgDwQhHuAgQfQjQE3AcL6ATcB/oUBN4QPmeIBN4APrJABM4NOxIIBJgHEjgEmAcb6ASYB9oUBJoIqHeQBJoMqOo0BJoAIQYN+WYIj/4IDkYIKA4At4gFGgA1zgQWPAQiBBYqBCgOAAA+ALiGBBY8BCIQKBwL/AYCX+4MQmoEJsYEQmoGRooUMkIBNOoAMC4FKnYMNKIMOBYCNHYEAnYAOzgEEgAyugkONAQSAHRKCGyuAAWKABV+FAECCBLKBBKWBelmEMPOBABiALt6DABgBDYM9nQENgSpzgATvgQ9cghCPgAAIgj4agAuPgw1cgBraigBCggBjggBagXhbgQDtgQy3gQA/hA+tgXl3gQEpgg9Vg39uhA0ehQAVgCmLAwALg4EahIANGYKMDoQ7zoF2X4EACIVf84ApfoEACoEPggEggS+3gRYHgz0KAduAG6oEAUEWTYAru4AGs4BfxgSggAJxgCe4gQBNgzb1AQGAm8aCC9oDQSpGgUA4AgVGgV/lAwBBOYEtAYEG+YACXwML3AmCAYaBkPqAQs6CAhQBLIEr9oAG34Byv4EAD4AAA4BUXoIruoMpOYMXo4J74YJ64YMCLgJBKoAWwAJ1IoB5b4EBtYACSIEAFwFsgwg5AVyAJaiAAYiBi42BmLaABI6BAGuAAtyBYhyDFJsBT4ASTwFLgRbjgBwAAUWAZfIFIARHcnKBZFuCLJyEPNCADFuAanOALKmBArqCAs6AW2qAHU2EFgOFABOAIpmGGnCHABaBk/WAJCqEGmWHABiAHY6GNKSDLnaAHKKEgHOBARiBAAgBOIIAxoFD5IEAt4AfvoI33oIBBIBEMoEAJYE3q4KLFIE3fYEvroALx4EADYAD8YIDboIAXQFcggANgVH9gDfGgQF/hRk/ghyqgDWFAhA3gi0NhwARggBWggANgQdeg4kngTlhhBrqgn4/ggFjgBCcghjugQMTgn/Tg35DgQGEggJ8gRB6gYGUggSbAiwigjMagnvKgRyjgi+MgQJjgQEkgQDZhAAlgi3XggPbAWyDAEOAABeAY6iBAdiAAWQBBIKY/IAAkYEuKIE0KIEASIEDw4FFAIQBIAGwgARGAUGDg9SCCUGBAHCCALCAAEKBAAcCtC2BQI2CErcBtIMAGYEwFoQBe4ADUYNBOIIAkAFsgSTPgQCLgglSgQChgwBBgWkGgQq/AgVJgDrTgABhggBIgQC0AVyBBT+AACMCxC2BHueCABMCxC2CDtUBBIM0JwEBgAMkgZ9RhAFCgTZXgSIAgQL+gQGtgBpkhgD0gi8LhAAlggCygQLVggmMgEILgCo5gQBfgpJ7gwCggTnLgQHphAESgomvggFZmAESgEgVhBOsAWyDA1SFARyCAYeCBo6CAnCCP+yBBYqBMs2BG1iDATaADQEBA4ICP4MBLIGUmoMAjIIAOIUBLIAAo4QAPIABToMAWJABJIQBAYAMkoAKeIQDy4IDCIUD54EBDoAy2IIDt4QCUoFG+IAD0IMhhoAQtAFFhQO0AQaAYV6ElV6CAWODgx6DAKgBOIAFMYIMfINHdoGAO4ID7IAE6gEagzHAgwGWARqCOzWAGJmBA/yDA0qBAwGCAWGBA7KBEucBQYBa0AEDgorSAUGAQkuAHV6AJIUBi4Muz4JjnwEQgAqkgy9fghfJgGs+gRqTgZSshAVsgjkFgBo7hQJxgBT5ggN/gi+VgAAYgAANgUSGgQQ2ggANhAPVgRptg4FPggBdgWVqgwAcgjVdggAWgACQBBALC4SBHe6BADKAZCeCBEiBJ6WCBAOCA0SCXCyCANGBAiuHHWiAOaYBGIEyp4M4rIIAcwEwgh73gUB/hBGLhQAThDpohABGgACkhAf2gAS4gAANgSI8BQuECQEPgQd3gSDogRk+gR2ugiSDhwByA3RBhYJaSAEAgTcpggARgAKzAoYCgjy1gzCEgzmvgTU8hABuAVSDAriDAoyABwSCAe8BSIEABQNYdHOAgKOBS3qAAA2EAq4BNIAfAoMWcIBQpYMU04EHUIAJTIIDR4IStYQBlQEsgAB5gUUWAgNrgQdtggQrAhA6gjXFggD7gjU7ggT1g1N4ggA0gDTFgwNagTR/gQARgTTFggMWgAAFAXCABQSGCQ6SACqBjzybACKCNd2CBnaBhJqGNd2AEVyBNd2EFZ+DJUqBb16BUiSBXVmBDn+EEKyBRMCAF8QCkCOBCDCCDVyKADaCAHsBdIIA34EE34ABP4IADQKkLYEUSIEAlYFFVoABgIMD3QKAAYUeEoIV04AN6wFgggGIgRz7ggEkAUiDB7EBbIMEXwE0gBfTgQGMgCyFgQGCg0X7AVSATfeBAa6BLTmBAEmCAPaEBdeBFIqECR8DEHRzgE6AgXH3AUiCbhYBDIMByoAlXoIBx4EWIYJfWYELGIMKUoUAkYIpSYI1A4QAV4AksIA4K4ILfoM2+ocEuoQAd4IEIYAAD4FUqYQCQ4MCbIFU7oMBjoECXoEAGYIATYILMoIANYEASYQ7S5YBxogaprAAH4ML3IFSwJQBvYQ3FYMA1YcBTII3FIIBy4Kb1IFEoIQGToALSoE3GYIAwAECgzcZgQQXgjcZgwBGiATxgQAHgztQgpoMgaJtgwY4gAFgAU+AR+2HOqeEAF6CaZKEAF4BAYQ6V4GXJIE6pI0AXoI6pIQAYgEbg0YtAqAtgzpRnQBPmQCtgUaZgAdfgSH2Awu+BYARsoID4IALqYAD4oMKa4Kg0IEACYI03oIEUQFqgRSLggAdASyAA5qCBJaBB1SBEaaBlb6AGIyFBa8BcIAKVoFeh4QCR4AKY4I8vYQGL4EAHAFcgwR+ArQtgj7kgQuahAh0AUSBAAUBTIEd6YMRy4FEIoEAioABCIIG6oMQ7IAADIJD/gQgCE8bhCWjgAuDhAmAgwyeghqkghjOpQA7gBe5gA3PhAhogIXWgkb8gQJEgwV5gwFiAgRqgAcmAhA3ggASggfYAXSDADCBB9GBExCABYmEAneBCG6CAP+BQoGAHleCHDuHAzqBDQ2BAzyCBA8BWIAxKIAFnIAf7YBRFoEQJoEStYAAfoKUb4NAfoEqL4AD8gEIhAAmggDogAAFgEpLiAXCggE3ASKAUjSCA/uAHNyDAwWCGs6CAWSFHIeCHayCWIOBGjMBhYEACoQCHIE/0IUJbIMJaQHEgB9TgiMLgyUbggEJgCM+gAJlgWAGAYKCOwqBpCIBAYAADIAIhYEjHICKGIVKgIEDQoEISoI4p4Gc0YIPTII8CoAAQoGlpIECroGKCIEAB4QM74AHjIAUI4UAQQEBgp+Wg4b2gQCPgA0CgABDgRRxgAkhAwurBIAflIEAGQF8gRlHgCjfgQAMAXiDAX0CjAGFDTuECuUCLGuAAuOBGcCBBUoBA4Bh7YIFgAGQgJACggDbgAGVgAxUgAA0ggWQATiAHMmBoHWBURaABZQBB4I9k4Eq9YEu9oEE04NYIoEACoIAmgE0gB2AgQGYgx0pgQrWgF3AgQv/gwAvgBnzgk6gggAyAiALggiTgQAKgVo7hAANgANKgz4KgT34gxIwiGYwhj3/gACAggAtgQV9gT3QgAANgAHRgj4FgAv0gTEugAANgDpAgAKSgTEigAANgAnHgABQgTEWgAANgD4OgASegTEKgAANgD4RgAGDgTD+gAANghRqgQVKgQc8gBAMgg9KgC6rgT4XgAeMgSC4gz4egACfhD4egRB8g4WQgF9PgQAKgkAHgB3cAQaDRdOAETUBBoOhO4JbW4Ico4AA14IU84IeS4Ja5oBt5oMCFIAC7oMn2YAC5oBKAQEggiLrAQODTo2BAPmDAXeALCiCAAqAABSBTpcBDIBNGIBf84IDCYED5gEBgQuugS53AiIJgQLOgRlLgQAEBUkbC6ALgRwpgwlzgSoZhAlzhQl1ggIFiQlzAUWDAheBCXSAQJyAAV2AQuKCBX2RCXOCAmKaCXODB/WTCXOCCWyAApWFHAOCCHEDNgJ4hAVTgGUYgAIVgSJAgABPAWCBToiFAFABgIIA74EC3YIJoYQEdIUJpAEEgAmkgwf2gEy2hibRgh5MgAulgAH9AUGAAUODADWBAGeAVAMBIIEA2YgAbIIC3AF4gqObgwjoAQWFYMiAABiJB5GCBjeBA0KAAAmFCeiDCogBZIAP7oACT5sHx4BQvccJ7YEo3LQJ7QF4gR3fggkrhAF8gD9QgAeegACMgCjkgRsVglojgQDdgwahAaSCAPoCoC2OCa6AHeWEHbKEAiOBBQyCNMyJAh6ABZiVBc+DIGSLCcqCGiOECcsBeIQJy4MCE4IJvAFohQnZgQ5zgZHUhgl5AVyBUIeGCCoBBIUIKoCjT5oI14Kk+IAACgFohQWOggX+hAT38gnUhwm4iAlVkAmzggLUlAm2hANigQoOhgiahgoohgD6AQSCobKDAVWUAC6ABJiCqZ//ASGHASGCAgjoCouGAmG4CouBBF6AjxYDAAs/gg+agQAejxcghj/GlAAfgAAcglI2AgRAgAGUAQOAAA0CgweBN1qFP2KAENOAIiWBLjyATW2Al8aCULCOdeuFDu+BFfgBQYAjsIAAMAF/gFCoAQaCpL0CAEiAP46BE52BFj+CMuiAVRiCesqCBTGBNXiBF4mCBtyAF3qCkRUCCEmBIbwCS3KAFfOAUuKCBRCBdj8ByIAJjYFUz4MAcINePYNXjIEFY4KaDQJBKoEQioABX4IWuQRC//+BgmzZAVSAAAwDgICCgFF3ATeAW8SATlOBAWaACXmCVmiCFoOBAAyBWtqBCt2DVJiBAHWBI8+CAOSAAHeBVUSEABaBT4aJABmCAseCABcBTIcAF4JCFIAAHQHEgR6TgABegFkbgDjKgAAJAZyEMQgBKIEAD4AYXoQAMIEEgIFkuIAARgGcgSwPAQKAXrGAe+eDFRQBOIJXqYAE84QACAFEgks1gpMgg0Q6gAGRAYCCZ2yAQRSAeNaCB/2BAH4BiIEjhIALRQGEgQCOgCoZgGkkggpUATaCRV2BQzUBbIAFngE2gAQbg5DfAhA0ggHdgACMgBN2incXgACngY9Wg19ShRIZg0G7gAUngRpRgQokgWVJg0G9BEE5QSqBJY+AAdSCp0+CK4mBAv6DS0qCNWeDUoqACpeAS++BAGaAE6ODCCuEQ/oGQYgRNgK4gI+lgAALgB8IgBRvgo+xgHpvAayDABWACJaAALyBABUB4IAAFQGggwAVgAijgADfgQAVAX6CeBOAKpCDAL2BAK4BLIAGIoRbhIVEKIIoEgFEgDgahDK+ghZehQuBhkQhgiqgAiA3gQbcgQCrgG1ihQAShEQ3AUiDAReAMFsCDGyAGOQClCCBCVoBNoALK4EDbwJBkIQADwGMgwAPAZKEAA8BgIMADwGWhAAPAXyBDmACC0ODGVyBWjCXGVyCDWuBOE2CGVyBAAqAATmAeSgBSYIEGgMLC+OAjWKAAhQEC6EEaYCzYAVmZmljaYCy5QEgg7TZEwAxLjMuMS4xLW1vdGxleQBpbnaAs20VZCBsaXRlcmFsL2xlbmd0aHMgc2V0hgAcBWNvZGUgiQAZD3Vua25vd24gaGVhZGVyIICz0wFniwAyAmRpgLN3AW6AtAmKABYDYml0hABHECByZXBlYXQAdG9vIG1hbnmFABcHc3ltYm9sc44AGAJvcoYAU4YAJIUAVoKz9IAAXYC0QAFrhQCmAgBigAD4gACaDGVycm9yAHN0cmVhbYQADYoA1QstLSBtaXNzaW5nIIC0pwQtb2YtggBHgAAlAmNvgLQtAmN0hQDjA2NoZYoAF4QAmI0AFwRkYXRhhgAViwELASCBANQFZmFyIGKAtJABAIUAVwJyY4EAgQVtYXRjaIYAMgF3gLT0BG93IHOBtQOGATuCAN4DdHlwhwATiwGyggDQjwB1ggAWhQGvBGNvbXCAtSQBc4C06YACDgR0aG9kgDInEwwLpQIDAAQABQAGAAcACAAJAAqAKQcNDQAPABEAEwAXABsAH4CVbhYrADMAOwBDAFMAYwBzAIMAowDDAOMAgAY4ggABAYCMAAIBgYQAAgGChAACAYOEAAIBhIQAAgGFhAACBZAASQDIghjMgK1JggCEAQeAAIABDYAAegEZgCkpATGAA4wBYYAARgHBgEjqAYGBSOyAQBYEAQYBCIApDAMQARiABbwJMAFAAWABgAHAiQB4hQBwhQBoAYaAAAIBh4AAAgGIgAACAYmAAAIBioAAAgGLgAACAYyAAAIBjYAAAgGOgAACARCAAHIBEoAAiAEIggCAAQaAAQIBBYABBAMEAAyAAJaAHJwCAA6AAKIBD4CwMwQOC7cMtQEsgBzVggABARCMAAIBEYQAAgEShAACAROEAAIBFIQAAgEVhAACARDAASyJAICFAHSFAGyBAGQBFoAAAgEXgAACARiAAAIBGYAAAgEagAACARuAAAIBHIAAAgEdgAACAUCAAAIGoAgAAKANgACIgADQAR6AAAQBD4AAVAEggAAQAiAOgwDgAR6AAASBABSBAAEBoIQAFAETgAAEAQeEABQBDIABOAGMgAAEAUyAAAQBzIAABAEsgAAEAayAAAQBbIAABAHsgAAEARyAAAQBnIAABAFcgAAEAdyAAAQBPIAABAG8gAAEAXyAAAQB/IAABAECgAAEAYKAAAQBQoAABAHCgAAEASKAAAQBooAABAFigAAEAeKAAAQBEoAABAGSgAAEAVKAAAQB0oAABAEygAAEAbKAAAQBcoAABAHygAAEAQqAAAQBioAABAFKgAAEAcqAAAQBKoAABAGqgAAEAWqAAAQB6oAABAEagAAEAZqAAAQBWoAABAHagAAEgHm4AgC6gAAEAXqAAAQB+oAABAEGgAAEAYaAAAQBRoAABAHGgAAEASaAAAQBpoAABAFmgAAEAeaAAAQBFoAABAGWgAAEAVaAAAQB1oAABAE2gAAEAbaAAAQBdoAABAH2gAAEAQ6AAAQBjoAABAFOgAAEAc6AAAQBLoAABAGugAAEAW6AAAQB7oAABAEegAAEAZ6AAAQBXoAABAHegAAEAT6AAAQBvoAABAF+gAAEAf6AAAQBAYAABAGBgAAEAUGAAAQBwYAABAEhgAAEAaGAAAQBYYAABAHhgAAEARGAAAQBkYAABAFRgAAEAdGAAAQBMYAABAGxgAAEAXGAAAQB8YAABAEJgAAEAYmAAAQBSYAABAHJgAAEASmAAAQBqYAABAFpgAAEAemAAAQBGYAABAGZgAAEAVmAAAQB2YAABAE5gAAEAbmAAAQBeYAABAH5gAAEAQWAAAQBhYAABAFFgAAEAcWAAAQBJYAABAGlgAAEAWWAAAQB5YAABAEVgAAEAZWAAAQBVYAABAHVgAAEATWAAAQBtYAABAF1gAAEAfWAAAQBDYAABAGNgAAEAU2AAAQBzYAABIARMwIArYAABAFtgAAEAe2AAAQBHYAABAGdgAAEAV2AAAQB3YAABAE9gAAEAb2AAAQBfYAABAH9gAAEAROAAMIFEwEJAJOAAAgBk4AACAFTgAAIAVOAAAgB04AACAHTgAAIATOAAAgBM4AACAGzgAAIAbOAAAgBc4AACAFzgAAIAfOAAAgB84AACAELgAAIgBDagAQCgAAEgAAIAUuAAAgBS4AACAHLgAAIAcuAAAgBK4AACAErgAAIAauAAAgBq4AACAFrgAAIAWuAAAgB64AACAHrgAAIARuAAAgBG4AACAGbgAAIAZuAAAgBW4AACAFbgAAIAduAAAgB24AACAE7gAAIATuAAAgBu4AACAG7gAAIAXuAAAgBe4AACAH7gAAIAfuAAAiBA7YBB4AACAGHgAAIAYeAAAgBR4AACAFHgAAIAceAAAgBx4AACAEngAAIASeAAAgBp4AACAGngAAIAWeAAAgBZ4AACAHngAAIAeeAAAgBF4AACAEXgAAIAZeAAAgBl4AACAFXgAAIAVeAAAgB14AACAHXgAAIATeAAAgBN4AACAG3gAAIAbeAAAgBd4AACAF3gAAIAfeAAAgB94AACAEPgAAIAQ+AAAgBj4AACAGPgAAIAU+AAAgBT4AACAHPgAAIAc+AAAgBL4AACAEvgAAIAa+AAAgBr4AACAFvgAAIAW+AAAgB74AACAHvgAAIAR+AAAgBH4AACAGfgAAIAZ+AAAgBX4AACAFfgAAIAd+AAAgB34AACAE/gAAIAT+AAAgBv4AACAG/gAAIAX+AAAgBf4AACAH/gAAIAf+AAAiBBAoBQIAABAEggAAEAWCAAAQBEIAABAFQgAAEATCAAAQBcIIFVgMHAEiAAAQBKIAABAFogAAEARiAAAQBWIAABAE4gAAEAXiAAAQBBIAABAFEgAAEASSAAAQBZIAABAEUgAAEAVSAAAQBNIAABAF0gAAEAQOAAEIBg4AABAFDgAAEAcOAAAQBI4AABAGjgAAEAWOAAAQB44AABIC+K4AAdIECxgEFgABcAQWCBUoBFIAABAEMgAAEARyAAASAvlaABEQBBYIGBAEaggXqAQWAA9QBBYADuAEFgAOcgE92gAAEARGAAAQBCYAABAEZgAAEgQACARWAAAQBDYAABAEdgAAEgL59gAKkgQZAAQWAAiyBBaYBBYABtAEFgD3fAxsLTYMfuYcABIC+rooABIEHUYkABAEEjAAEAQWKAAQEQbAcC4C9CosAS40AO4UALwEGhAAEgQWIgQAEgQEKgQAEgQGSgQAEgIS2ggAEAQuEAAQBDIQABIAF24FHeQTgHQsjhQBfhQXLAhARgAVtBgcJBgoFC4A6uAQNAg4BgAclBJQeC2mFAJCFAIiFAICFAHiBAGiBAFyBBh8BEIAABAEUgAAEARiAAAQBHIAABAEggAAEASiAAAQBMIAABAE4gAAEAUCAAAQBUIAABIEGvQFwgAAEAYCAAAQBoIAABAHAgAAEAeCAAG8DHwtyjQBvgQBrgQBngQBjgQBfgQBbgQBXgQBTgQBPgQBLgQBHgQBDgQE8AYCvAEGAUc0CC22BAMcBBIAAAgEIgAAEgQEzgQJLARCAAA6DAAyBnqyAqmuEACSBB3OBAE8BCIAACIEAGIUADIEIt4MADAEggQCUgDKEgQBrAYCBCC8BBIMADIA/SAoBABAMAEGRIQv/gCUfgMDAgIKxBQgJCQoKgEk3gAABAQ2AAAEBDoAAAQEPgAABARCEAAEBEYQAAQEShAABAROEAAEBFIwAAQEVjAABARaMAAEBF4wAAQEYnAABARmcAAEBGpwAAQEbmwABARyBffsEBAQFBYHB1QEHgAABAQiEAAGAXSqCAAEBCowAAYAnsooAAYEBMJkAAYEBTJkAAYEBaLkAAYEBpLkAAYIDdYABzoUBvI0BqJ0BkLwBgAIbHLwAAQEdvAABgA9PgH05A9AqAQ==")), B) });
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/zlib-wasm/zlib-streams.js
let wasm, malloc, free, memory;
function setWasmExports(wasmAPI) {
	wasm = wasmAPI;
	({malloc, free, memory} = wasm);
	if (typeof malloc !== "function" || typeof free !== "function" || !memory) {
		wasm = malloc = free = memory = null;
		throw new Error("Invalid WASM module");
	}
}
function _make(isCompress, type, options = {}) {
	const level = typeof options.level === "number" ? options.level : -1;
	const outBufferSize = typeof options.outBuffer === "number" ? options.outBuffer : 64 * 1024;
	const inBufferSize = typeof options.inBufferSize === "number" ? options.inBufferSize : 64 * 1024;
	return new TransformStream({
		start() {
			let result;
			this.out = malloc(outBufferSize);
			this.in = malloc(inBufferSize);
			this.inBufferSize = inBufferSize;
			this._scratch = new Uint8Array(outBufferSize);
			if (isCompress) {
				this._process = wasm.deflate_process;
				this._last_consumed = wasm.deflate_last_consumed;
				this._end = wasm.deflate_end;
				this.streamHandle = wasm.deflate_new();
				if (type === "gzip") result = wasm.deflate_init_gzip(this.streamHandle, level);
				else if (type === "deflate-raw") result = wasm.deflate_init_raw(this.streamHandle, level);
				else result = wasm.deflate_init(this.streamHandle, level);
			} else if (type === "deflate64-raw") {
				this._process = wasm.inflate9_process;
				this._last_consumed = wasm.inflate9_last_consumed;
				this._end = wasm.inflate9_end;
				this.streamHandle = wasm.inflate9_new();
				result = wasm.inflate9_init_raw(this.streamHandle);
			} else {
				this._process = wasm.inflate_process;
				this._last_consumed = wasm.inflate_last_consumed;
				this._end = wasm.inflate_end;
				this.streamHandle = wasm.inflate_new();
				if (type === "deflate-raw") result = wasm.inflate_init_raw(this.streamHandle);
				else if (type === "gzip") result = wasm.inflate_init_gzip(this.streamHandle);
				else result = wasm.inflate_init(this.streamHandle);
			}
			if (result !== 0) throw new Error("init failed:" + result);
		},
		transform(chunk, controller) {
			try {
				const buffer = chunk;
				const heap = new Uint8Array(memory.buffer);
				const process = this._process;
				const last_consumed = this._last_consumed;
				const out = this.out;
				const scratch = this._scratch;
				let offset = 0;
				while (offset < buffer.length) {
					const toRead = Math.min(buffer.length - offset, 32 * 1024);
					if (!this.in || this.inBufferSize < toRead) {
						if (this.in && free) free(this.in);
						this.in = malloc(toRead);
						this.inBufferSize = toRead;
					}
					heap.set(buffer.subarray(offset, offset + toRead), this.in);
					const result = process(this.streamHandle, this.in, toRead, out, outBufferSize, 0);
					const prod = result & 16777215;
					if (prod) {
						scratch.set(heap.subarray(out, out + prod), 0);
						controller.enqueue(scratch.slice(0, prod));
					}
					if (!isCompress) {
						const code = result >> 24 & 255;
						const signedCode = code & 128 ? code - 256 : code;
						if (signedCode < 0) throw new Error("process error:" + signedCode);
					}
					const consumed = last_consumed(this.streamHandle);
					if (consumed === 0) break;
					offset += consumed;
				}
			} catch (error) {
				if (this._end && this.streamHandle) this._end(this.streamHandle);
				if (this.in && free) free(this.in);
				if (this.out && free) free(this.out);
				controller.error(error);
			}
		},
		flush(controller) {
			try {
				const heap = new Uint8Array(memory.buffer);
				const process = this._process;
				const out = this.out;
				const scratch = this._scratch;
				while (true) {
					const result = process(this.streamHandle, 0, 0, out, outBufferSize, 4);
					const produced = result & 16777215;
					const code = result >> 24 & 255;
					if (!isCompress) {
						const signedCode = code & 128 ? code - 256 : code;
						if (signedCode < 0) throw new Error("process error:" + signedCode);
					}
					if (produced) {
						scratch.set(heap.subarray(out, out + produced), 0);
						controller.enqueue(scratch.slice(0, produced));
					}
					if (code === 1 || produced === 0) break;
				}
			} catch (error) {
				controller.error(error);
			} finally {
				if (this._end && this.streamHandle) {
					const result = this._end(this.streamHandle);
					if (result !== 0) controller.error(/* @__PURE__ */ new Error("end error:" + result));
				}
				if (this.in && free) free(this.in);
				if (this.out && free) free(this.out);
			}
		}
	});
}
var CompressionStreamZlib = class {
	constructor(type = "deflate", options) {
		return _make(true, type, options);
	}
};
var DecompressionStreamZlib = class {
	constructor(type = "deflate", options) {
		return _make(false, type, options);
	}
};
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/streams/zlib-wasm/zlib-streams-loader.js
let initializedModule = false;
async function initModule(wasmURI, { baseURI }) {
	if (!initializedModule) {
		let arrayBuffer, uri;
		try {
			try {
				uri = new URL(wasmURI, baseURI);
			} catch {}
			arrayBuffer = await (await fetch(uri)).arrayBuffer();
		} catch (error) {
			if (wasmURI.startsWith("data:application/wasm;base64,")) arrayBuffer = arrayBufferFromDataURI(wasmURI);
			else throw error;
		}
		setWasmExports((await WebAssembly.instantiate(arrayBuffer)).instance.exports);
		initializedModule = true;
	}
}
function arrayBufferFromDataURI(dataURI) {
	const base64 = dataURI.split(",")[1];
	const binary = atob(base64);
	const len = binary.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; ++i) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}
//#endregion
//#region node_modules/@zip.js/zip.js/lib/zip-module-wasm.js
let modulePromise;
g(configure);
configureWorker({ initModule: (config) => {
	if (!modulePromise) {
		let { wasmURI } = config;
		if (typeof wasmURI == "function") wasmURI = wasmURI();
		modulePromise = initModule(wasmURI, config);
	}
	return modulePromise;
} });
configure({
	CompressionStreamZlib,
	DecompressionStreamZlib
});
//#endregion
//#region node_modules/@zip.js/zip.js/lib/core/util/mime-type.js
const table = {
	"application": {
		"andrew-inset": "ez",
		"annodex": "anx",
		"atom+xml": "atom",
		"atomcat+xml": "atomcat",
		"atomserv+xml": "atomsrv",
		"bbolin": "lin",
		"cu-seeme": "cu",
		"davmount+xml": "davmount",
		"dsptype": "tsp",
		"ecmascript": ["es", "ecma"],
		"futuresplash": "spl",
		"hta": "hta",
		"java-archive": "jar",
		"java-serialized-object": "ser",
		"java-vm": "class",
		"m3g": "m3g",
		"mac-binhex40": "hqx",
		"mathematica": [
			"nb",
			"ma",
			"mb"
		],
		"msaccess": "mdb",
		"msword": [
			"doc",
			"dot",
			"wiz"
		],
		"mxf": "mxf",
		"oda": "oda",
		"ogg": "ogx",
		"pdf": "pdf",
		"pgp-keys": "key",
		"pgp-signature": ["asc", "sig"],
		"pics-rules": "prf",
		"postscript": [
			"ps",
			"ai",
			"eps",
			"epsi",
			"epsf",
			"eps2",
			"eps3"
		],
		"rar": "rar",
		"rdf+xml": "rdf",
		"rss+xml": "rss",
		"rtf": "rtf",
		"xhtml+xml": ["xhtml", "xht"],
		"xml": [
			"xml",
			"xsl",
			"xsd",
			"xpdl"
		],
		"xspf+xml": "xspf",
		"zip": "zip",
		"vnd.android.package-archive": "apk",
		"vnd.cinderella": "cdy",
		"vnd.google-earth.kml+xml": "kml",
		"vnd.google-earth.kmz": "kmz",
		"vnd.mozilla.xul+xml": "xul",
		"vnd.ms-excel": [
			"xls",
			"xlb",
			"xlt",
			"xlm",
			"xla",
			"xlc",
			"xlw"
		],
		"vnd.ms-pki.seccat": "cat",
		"vnd.ms-pki.stl": "stl",
		"vnd.ms-powerpoint": [
			"ppt",
			"pps",
			"pot",
			"ppa",
			"pwz"
		],
		"vnd.oasis.opendocument.chart": "odc",
		"vnd.oasis.opendocument.database": "odb",
		"vnd.oasis.opendocument.formula": "odf",
		"vnd.oasis.opendocument.graphics": "odg",
		"vnd.oasis.opendocument.graphics-template": "otg",
		"vnd.oasis.opendocument.image": "odi",
		"vnd.oasis.opendocument.presentation": "odp",
		"vnd.oasis.opendocument.presentation-template": "otp",
		"vnd.oasis.opendocument.spreadsheet": "ods",
		"vnd.oasis.opendocument.spreadsheet-template": "ots",
		"vnd.oasis.opendocument.text": "odt",
		"vnd.oasis.opendocument.text-master": ["odm", "otm"],
		"vnd.oasis.opendocument.text-template": "ott",
		"vnd.oasis.opendocument.text-web": "oth",
		"vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
		"vnd.openxmlformats-officedocument.spreadsheetml.template": "xltx",
		"vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
		"vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
		"vnd.openxmlformats-officedocument.presentationml.template": "potx",
		"vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
		"vnd.openxmlformats-officedocument.wordprocessingml.template": "dotx",
		"vnd.smaf": "mmf",
		"vnd.stardivision.calc": "sdc",
		"vnd.stardivision.chart": "sds",
		"vnd.stardivision.draw": "sda",
		"vnd.stardivision.impress": "sdd",
		"vnd.stardivision.math": ["sdf", "smf"],
		"vnd.stardivision.writer": ["sdw", "vor"],
		"vnd.stardivision.writer-global": "sgl",
		"vnd.sun.xml.calc": "sxc",
		"vnd.sun.xml.calc.template": "stc",
		"vnd.sun.xml.draw": "sxd",
		"vnd.sun.xml.draw.template": "std",
		"vnd.sun.xml.impress": "sxi",
		"vnd.sun.xml.impress.template": "sti",
		"vnd.sun.xml.math": "sxm",
		"vnd.sun.xml.writer": "sxw",
		"vnd.sun.xml.writer.global": "sxg",
		"vnd.sun.xml.writer.template": "stw",
		"vnd.symbian.install": ["sis", "sisx"],
		"vnd.visio": [
			"vsd",
			"vst",
			"vss",
			"vsw",
			"vsdx",
			"vssx",
			"vstx",
			"vssm",
			"vstm"
		],
		"vnd.wap.wbxml": "wbxml",
		"vnd.wap.wmlc": "wmlc",
		"vnd.wap.wmlscriptc": "wmlsc",
		"vnd.wordperfect": "wpd",
		"vnd.wordperfect5.1": "wp5",
		"x-123": "wk",
		"x-7z-compressed": "7z",
		"x-abiword": "abw",
		"x-apple-diskimage": "dmg",
		"x-bcpio": "bcpio",
		"x-bittorrent": "torrent",
		"x-cbr": [
			"cbr",
			"cba",
			"cbt",
			"cb7"
		],
		"x-cbz": "cbz",
		"x-cdf": ["cdf", "cda"],
		"x-cdlink": "vcd",
		"x-chess-pgn": "pgn",
		"x-cpio": "cpio",
		"x-csh": "csh",
		"x-director": [
			"dir",
			"dxr",
			"cst",
			"cct",
			"cxt",
			"w3d",
			"fgd",
			"swa"
		],
		"x-dms": "dms",
		"x-doom": "wad",
		"x-dvi": "dvi",
		"x-httpd-eruby": "rhtml",
		"x-font": "pcf.Z",
		"x-freemind": "mm",
		"x-gnumeric": "gnumeric",
		"x-go-sgf": "sgf",
		"x-graphing-calculator": "gcf",
		"x-gtar": ["gtar", "taz"],
		"x-hdf": "hdf",
		"x-httpd-php": [
			"phtml",
			"pht",
			"php"
		],
		"x-httpd-php-source": "phps",
		"x-httpd-php3": "php3",
		"x-httpd-php3-preprocessed": "php3p",
		"x-httpd-php4": "php4",
		"x-httpd-php5": "php5",
		"x-ica": "ica",
		"x-info": "info",
		"x-internet-signup": ["ins", "isp"],
		"x-iphone": "iii",
		"x-iso9660-image": "iso",
		"x-java-jnlp-file": "jnlp",
		"x-jmol": "jmz",
		"x-killustrator": "kil",
		"x-latex": "latex",
		"x-lyx": "lyx",
		"x-lzx": "lzx",
		"x-maker": [
			"frm",
			"fb",
			"fbdoc"
		],
		"x-ms-wmd": "wmd",
		"x-msdos-program": [
			"com",
			"exe",
			"bat",
			"dll"
		],
		"x-netcdf": ["nc"],
		"x-ns-proxy-autoconfig": ["pac", "dat"],
		"x-nwc": "nwc",
		"x-object": "o",
		"x-oz-application": "oza",
		"x-pkcs7-certreqresp": "p7r",
		"x-python-code": ["pyc", "pyo"],
		"x-qgis": [
			"qgs",
			"shp",
			"shx"
		],
		"x-quicktimeplayer": "qtl",
		"x-redhat-package-manager": ["rpm", "rpa"],
		"x-ruby": "rb",
		"x-sh": "sh",
		"x-shar": "shar",
		"x-shockwave-flash": ["swf", "swfl"],
		"x-silverlight": "scr",
		"x-stuffit": "sit",
		"x-sv4cpio": "sv4cpio",
		"x-sv4crc": "sv4crc",
		"x-tar": "tar",
		"x-tex-gf": "gf",
		"x-tex-pk": "pk",
		"x-texinfo": ["texinfo", "texi"],
		"x-trash": [
			"~",
			"%",
			"bak",
			"old",
			"sik"
		],
		"x-ustar": "ustar",
		"x-wais-source": "src",
		"x-wingz": "wz",
		"x-x509-ca-cert": [
			"crt",
			"der",
			"cer"
		],
		"x-xcf": "xcf",
		"x-xfig": "fig",
		"x-xpinstall": "xpi",
		"applixware": "aw",
		"atomsvc+xml": "atomsvc",
		"ccxml+xml": "ccxml",
		"cdmi-capability": "cdmia",
		"cdmi-container": "cdmic",
		"cdmi-domain": "cdmid",
		"cdmi-object": "cdmio",
		"cdmi-queue": "cdmiq",
		"docbook+xml": "dbk",
		"dssc+der": "dssc",
		"dssc+xml": "xdssc",
		"emma+xml": "emma",
		"epub+zip": "epub",
		"exi": "exi",
		"font-tdpfr": "pfr",
		"gml+xml": "gml",
		"gpx+xml": "gpx",
		"gxf": "gxf",
		"hyperstudio": "stk",
		"inkml+xml": ["ink", "inkml"],
		"ipfix": "ipfix",
		"jsonml+json": "jsonml",
		"lost+xml": "lostxml",
		"mads+xml": "mads",
		"marc": "mrc",
		"marcxml+xml": "mrcx",
		"mathml+xml": ["mathml", "mml"],
		"mbox": "mbox",
		"mediaservercontrol+xml": "mscml",
		"metalink+xml": "metalink",
		"metalink4+xml": "meta4",
		"mets+xml": "mets",
		"mods+xml": "mods",
		"mp21": ["m21", "mp21"],
		"mp4": "mp4s",
		"oebps-package+xml": "opf",
		"omdoc+xml": "omdoc",
		"onenote": [
			"onetoc",
			"onetoc2",
			"onetmp",
			"onepkg"
		],
		"oxps": "oxps",
		"patch-ops-error+xml": "xer",
		"pgp-encrypted": "pgp",
		"pkcs10": "p10",
		"pkcs7-mime": ["p7m", "p7c"],
		"pkcs7-signature": "p7s",
		"pkcs8": "p8",
		"pkix-attr-cert": "ac",
		"pkix-crl": "crl",
		"pkix-pkipath": "pkipath",
		"pkixcmp": "pki",
		"pls+xml": "pls",
		"prs.cww": "cww",
		"pskc+xml": "pskcxml",
		"reginfo+xml": "rif",
		"relax-ng-compact-syntax": "rnc",
		"resource-lists+xml": "rl",
		"resource-lists-diff+xml": "rld",
		"rls-services+xml": "rs",
		"rpki-ghostbusters": "gbr",
		"rpki-manifest": "mft",
		"rpki-roa": "roa",
		"rsd+xml": "rsd",
		"sbml+xml": "sbml",
		"scvp-cv-request": "scq",
		"scvp-cv-response": "scs",
		"scvp-vp-request": "spq",
		"scvp-vp-response": "spp",
		"sdp": "sdp",
		"set-payment-initiation": "setpay",
		"set-registration-initiation": "setreg",
		"shf+xml": "shf",
		"sparql-query": "rq",
		"sparql-results+xml": "srx",
		"srgs": "gram",
		"srgs+xml": "grxml",
		"sru+xml": "sru",
		"ssdl+xml": "ssdl",
		"ssml+xml": "ssml",
		"tei+xml": ["tei", "teicorpus"],
		"thraud+xml": "tfi",
		"timestamped-data": "tsd",
		"vnd.3gpp.pic-bw-large": "plb",
		"vnd.3gpp.pic-bw-small": "psb",
		"vnd.3gpp.pic-bw-var": "pvb",
		"vnd.3gpp2.tcap": "tcap",
		"vnd.3m.post-it-notes": "pwn",
		"vnd.accpac.simply.aso": "aso",
		"vnd.accpac.simply.imp": "imp",
		"vnd.acucobol": "acu",
		"vnd.acucorp": ["atc", "acutc"],
		"vnd.adobe.air-application-installer-package+zip": "air",
		"vnd.adobe.formscentral.fcdt": "fcdt",
		"vnd.adobe.fxp": ["fxp", "fxpl"],
		"vnd.adobe.xdp+xml": "xdp",
		"vnd.adobe.xfdf": "xfdf",
		"vnd.ahead.space": "ahead",
		"vnd.airzip.filesecure.azf": "azf",
		"vnd.airzip.filesecure.azs": "azs",
		"vnd.amazon.ebook": "azw",
		"vnd.americandynamics.acc": "acc",
		"vnd.amiga.ami": "ami",
		"vnd.anser-web-certificate-issue-initiation": "cii",
		"vnd.anser-web-funds-transfer-initiation": "fti",
		"vnd.antix.game-component": "atx",
		"vnd.apple.installer+xml": "mpkg",
		"vnd.apple.mpegurl": "m3u8",
		"vnd.aristanetworks.swi": "swi",
		"vnd.astraea-software.iota": "iota",
		"vnd.audiograph": "aep",
		"vnd.blueice.multipass": "mpm",
		"vnd.bmi": "bmi",
		"vnd.businessobjects": "rep",
		"vnd.chemdraw+xml": "cdxml",
		"vnd.chipnuts.karaoke-mmd": "mmd",
		"vnd.claymore": "cla",
		"vnd.cloanto.rp9": "rp9",
		"vnd.clonk.c4group": [
			"c4g",
			"c4d",
			"c4f",
			"c4p",
			"c4u"
		],
		"vnd.cluetrust.cartomobile-config": "c11amc",
		"vnd.cluetrust.cartomobile-config-pkg": "c11amz",
		"vnd.commonspace": "csp",
		"vnd.contact.cmsg": "cdbcmsg",
		"vnd.cosmocaller": "cmc",
		"vnd.crick.clicker": "clkx",
		"vnd.crick.clicker.keyboard": "clkk",
		"vnd.crick.clicker.palette": "clkp",
		"vnd.crick.clicker.template": "clkt",
		"vnd.crick.clicker.wordbank": "clkw",
		"vnd.criticaltools.wbs+xml": "wbs",
		"vnd.ctc-posml": "pml",
		"vnd.cups-ppd": "ppd",
		"vnd.curl.car": "car",
		"vnd.curl.pcurl": "pcurl",
		"vnd.dart": "dart",
		"vnd.data-vision.rdz": "rdz",
		"vnd.dece.data": [
			"uvf",
			"uvvf",
			"uvd",
			"uvvd"
		],
		"vnd.dece.ttml+xml": ["uvt", "uvvt"],
		"vnd.dece.unspecified": ["uvx", "uvvx"],
		"vnd.dece.zip": ["uvz", "uvvz"],
		"vnd.denovo.fcselayout-link": "fe_launch",
		"vnd.dna": "dna",
		"vnd.dolby.mlp": "mlp",
		"vnd.dpgraph": "dpg",
		"vnd.dreamfactory": "dfac",
		"vnd.ds-keypoint": "kpxx",
		"vnd.dvb.ait": "ait",
		"vnd.dvb.service": "svc",
		"vnd.dynageo": "geo",
		"vnd.ecowin.chart": "mag",
		"vnd.enliven": "nml",
		"vnd.epson.esf": "esf",
		"vnd.epson.msf": "msf",
		"vnd.epson.quickanime": "qam",
		"vnd.epson.salt": "slt",
		"vnd.epson.ssf": "ssf",
		"vnd.eszigno3+xml": ["es3", "et3"],
		"vnd.ezpix-album": "ez2",
		"vnd.ezpix-package": "ez3",
		"vnd.fdf": "fdf",
		"vnd.fdsn.mseed": "mseed",
		"vnd.fdsn.seed": ["seed", "dataless"],
		"vnd.flographit": "gph",
		"vnd.fluxtime.clip": "ftc",
		"vnd.framemaker": [
			"fm",
			"frame",
			"maker",
			"book"
		],
		"vnd.frogans.fnc": "fnc",
		"vnd.frogans.ltf": "ltf",
		"vnd.fsc.weblaunch": "fsc",
		"vnd.fujitsu.oasys": "oas",
		"vnd.fujitsu.oasys2": "oa2",
		"vnd.fujitsu.oasys3": "oa3",
		"vnd.fujitsu.oasysgp": "fg5",
		"vnd.fujitsu.oasysprs": "bh2",
		"vnd.fujixerox.ddd": "ddd",
		"vnd.fujixerox.docuworks": "xdw",
		"vnd.fujixerox.docuworks.binder": "xbd",
		"vnd.fuzzysheet": "fzs",
		"vnd.genomatix.tuxedo": "txd",
		"vnd.geogebra.file": "ggb",
		"vnd.geogebra.tool": "ggt",
		"vnd.geometry-explorer": ["gex", "gre"],
		"vnd.geonext": "gxt",
		"vnd.geoplan": "g2w",
		"vnd.geospace": "g3w",
		"vnd.gmx": "gmx",
		"vnd.grafeq": ["gqf", "gqs"],
		"vnd.groove-account": "gac",
		"vnd.groove-help": "ghf",
		"vnd.groove-identity-message": "gim",
		"vnd.groove-injector": "grv",
		"vnd.groove-tool-message": "gtm",
		"vnd.groove-tool-template": "tpl",
		"vnd.groove-vcard": "vcg",
		"vnd.hal+xml": "hal",
		"vnd.handheld-entertainment+xml": "zmm",
		"vnd.hbci": "hbci",
		"vnd.hhe.lesson-player": "les",
		"vnd.hp-hpgl": "hpgl",
		"vnd.hp-hpid": "hpid",
		"vnd.hp-hps": "hps",
		"vnd.hp-jlyt": "jlt",
		"vnd.hp-pcl": "pcl",
		"vnd.hp-pclxl": "pclxl",
		"vnd.hydrostatix.sof-data": "sfd-hdstx",
		"vnd.ibm.minipay": "mpy",
		"vnd.ibm.modcap": [
			"afp",
			"listafp",
			"list3820"
		],
		"vnd.ibm.rights-management": "irm",
		"vnd.ibm.secure-container": "sc",
		"vnd.iccprofile": ["icc", "icm"],
		"vnd.igloader": "igl",
		"vnd.immervision-ivp": "ivp",
		"vnd.immervision-ivu": "ivu",
		"vnd.insors.igm": "igm",
		"vnd.intercon.formnet": ["xpw", "xpx"],
		"vnd.intergeo": "i2g",
		"vnd.intu.qbo": "qbo",
		"vnd.intu.qfx": "qfx",
		"vnd.ipunplugged.rcprofile": "rcprofile",
		"vnd.irepository.package+xml": "irp",
		"vnd.is-xpr": "xpr",
		"vnd.isac.fcs": "fcs",
		"vnd.jam": "jam",
		"vnd.jcp.javame.midlet-rms": "rms",
		"vnd.jisp": "jisp",
		"vnd.joost.joda-archive": "joda",
		"vnd.kahootz": ["ktz", "ktr"],
		"vnd.kde.karbon": "karbon",
		"vnd.kde.kchart": "chrt",
		"vnd.kde.kformula": "kfo",
		"vnd.kde.kivio": "flw",
		"vnd.kde.kontour": "kon",
		"vnd.kde.kpresenter": ["kpr", "kpt"],
		"vnd.kde.kspread": "ksp",
		"vnd.kde.kword": ["kwd", "kwt"],
		"vnd.kenameaapp": "htke",
		"vnd.kidspiration": "kia",
		"vnd.kinar": ["kne", "knp"],
		"vnd.koan": [
			"skp",
			"skd",
			"skt",
			"skm"
		],
		"vnd.kodak-descriptor": "sse",
		"vnd.las.las+xml": "lasxml",
		"vnd.llamagraphics.life-balance.desktop": "lbd",
		"vnd.llamagraphics.life-balance.exchange+xml": "lbe",
		"vnd.lotus-1-2-3": "123",
		"vnd.lotus-approach": "apr",
		"vnd.lotus-freelance": "pre",
		"vnd.lotus-notes": "nsf",
		"vnd.lotus-organizer": "org",
		"vnd.lotus-screencam": "scm",
		"vnd.lotus-wordpro": "lwp",
		"vnd.macports.portpkg": "portpkg",
		"vnd.mcd": "mcd",
		"vnd.medcalcdata": "mc1",
		"vnd.mediastation.cdkey": "cdkey",
		"vnd.mfer": "mwf",
		"vnd.mfmp": "mfm",
		"vnd.micrografx.flo": "flo",
		"vnd.micrografx.igx": "igx",
		"vnd.mif": "mif",
		"vnd.mobius.daf": "daf",
		"vnd.mobius.dis": "dis",
		"vnd.mobius.mbk": "mbk",
		"vnd.mobius.mqy": "mqy",
		"vnd.mobius.msl": "msl",
		"vnd.mobius.plc": "plc",
		"vnd.mobius.txf": "txf",
		"vnd.mophun.application": "mpn",
		"vnd.mophun.certificate": "mpc",
		"vnd.ms-artgalry": "cil",
		"vnd.ms-cab-compressed": "cab",
		"vnd.ms-excel.addin.macroenabled.12": "xlam",
		"vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
		"vnd.ms-excel.sheet.macroenabled.12": "xlsm",
		"vnd.ms-excel.template.macroenabled.12": "xltm",
		"vnd.ms-fontobject": "eot",
		"vnd.ms-htmlhelp": "chm",
		"vnd.ms-ims": "ims",
		"vnd.ms-lrm": "lrm",
		"vnd.ms-officetheme": "thmx",
		"vnd.ms-powerpoint.addin.macroenabled.12": "ppam",
		"vnd.ms-powerpoint.presentation.macroenabled.12": "pptm",
		"vnd.ms-powerpoint.slide.macroenabled.12": "sldm",
		"vnd.ms-powerpoint.slideshow.macroenabled.12": "ppsm",
		"vnd.ms-powerpoint.template.macroenabled.12": "potm",
		"vnd.ms-project": ["mpp", "mpt"],
		"vnd.ms-word.document.macroenabled.12": "docm",
		"vnd.ms-word.template.macroenabled.12": "dotm",
		"vnd.ms-works": [
			"wps",
			"wks",
			"wcm",
			"wdb"
		],
		"vnd.ms-wpl": "wpl",
		"vnd.ms-xpsdocument": "xps",
		"vnd.mseq": "mseq",
		"vnd.musician": "mus",
		"vnd.muvee.style": "msty",
		"vnd.mynfc": "taglet",
		"vnd.neurolanguage.nlu": "nlu",
		"vnd.nitf": ["ntf", "nitf"],
		"vnd.noblenet-directory": "nnd",
		"vnd.noblenet-sealer": "nns",
		"vnd.noblenet-web": "nnw",
		"vnd.nokia.n-gage.data": "ngdat",
		"vnd.nokia.n-gage.symbian.install": "n-gage",
		"vnd.nokia.radio-preset": "rpst",
		"vnd.nokia.radio-presets": "rpss",
		"vnd.novadigm.edm": "edm",
		"vnd.novadigm.edx": "edx",
		"vnd.novadigm.ext": "ext",
		"vnd.oasis.opendocument.chart-template": "otc",
		"vnd.oasis.opendocument.formula-template": "odft",
		"vnd.oasis.opendocument.image-template": "oti",
		"vnd.olpc-sugar": "xo",
		"vnd.oma.dd2+xml": "dd2",
		"vnd.openofficeorg.extension": "oxt",
		"vnd.openxmlformats-officedocument.presentationml.slide": "sldx",
		"vnd.osgeo.mapguide.package": "mgp",
		"vnd.osgi.dp": "dp",
		"vnd.osgi.subsystem": "esa",
		"vnd.palm": [
			"pdb",
			"pqa",
			"oprc"
		],
		"vnd.pawaafile": "paw",
		"vnd.pg.format": "str",
		"vnd.pg.osasli": "ei6",
		"vnd.picsel": "efif",
		"vnd.pmi.widget": "wg",
		"vnd.pocketlearn": "plf",
		"vnd.powerbuilder6": "pbd",
		"vnd.previewsystems.box": "box",
		"vnd.proteus.magazine": "mgz",
		"vnd.publishare-delta-tree": "qps",
		"vnd.pvi.ptid1": "ptid",
		"vnd.quark.quarkxpress": [
			"qxd",
			"qxt",
			"qwd",
			"qwt",
			"qxl",
			"qxb"
		],
		"vnd.realvnc.bed": "bed",
		"vnd.recordare.musicxml": "mxl",
		"vnd.recordare.musicxml+xml": "musicxml",
		"vnd.rig.cryptonote": "cryptonote",
		"vnd.rn-realmedia": "rm",
		"vnd.rn-realmedia-vbr": "rmvb",
		"vnd.route66.link66+xml": "link66",
		"vnd.sailingtracker.track": "st",
		"vnd.seemail": "see",
		"vnd.sema": "sema",
		"vnd.semd": "semd",
		"vnd.semf": "semf",
		"vnd.shana.informed.formdata": "ifm",
		"vnd.shana.informed.formtemplate": "itp",
		"vnd.shana.informed.interchange": "iif",
		"vnd.shana.informed.package": "ipk",
		"vnd.simtech-mindmapper": ["twd", "twds"],
		"vnd.smart.teacher": "teacher",
		"vnd.solent.sdkm+xml": ["sdkm", "sdkd"],
		"vnd.spotfire.dxp": "dxp",
		"vnd.spotfire.sfs": "sfs",
		"vnd.stepmania.package": "smzip",
		"vnd.stepmania.stepchart": "sm",
		"vnd.sus-calendar": ["sus", "susp"],
		"vnd.svd": "svd",
		"vnd.syncml+xml": "xsm",
		"vnd.syncml.dm+wbxml": "bdm",
		"vnd.syncml.dm+xml": "xdm",
		"vnd.tao.intent-module-archive": "tao",
		"vnd.tcpdump.pcap": [
			"pcap",
			"cap",
			"dmp"
		],
		"vnd.tmobile-livetv": "tmo",
		"vnd.trid.tpt": "tpt",
		"vnd.triscape.mxs": "mxs",
		"vnd.trueapp": "tra",
		"vnd.ufdl": ["ufd", "ufdl"],
		"vnd.uiq.theme": "utz",
		"vnd.umajin": "umj",
		"vnd.unity": "unityweb",
		"vnd.uoml+xml": "uoml",
		"vnd.vcx": "vcx",
		"vnd.visionary": "vis",
		"vnd.vsf": "vsf",
		"vnd.webturbo": "wtb",
		"vnd.wolfram.player": "nbp",
		"vnd.wqd": "wqd",
		"vnd.wt.stf": "stf",
		"vnd.xara": "xar",
		"vnd.xfdl": "xfdl",
		"vnd.yamaha.hv-dic": "hvd",
		"vnd.yamaha.hv-script": "hvs",
		"vnd.yamaha.hv-voice": "hvp",
		"vnd.yamaha.openscoreformat": "osf",
		"vnd.yamaha.openscoreformat.osfpvg+xml": "osfpvg",
		"vnd.yamaha.smaf-audio": "saf",
		"vnd.yamaha.smaf-phrase": "spf",
		"vnd.yellowriver-custom-menu": "cmp",
		"vnd.zul": ["zir", "zirz"],
		"vnd.zzazz.deck+xml": "zaz",
		"voicexml+xml": "vxml",
		"widget": "wgt",
		"winhlp": "hlp",
		"wsdl+xml": "wsdl",
		"wspolicy+xml": "wspolicy",
		"x-ace-compressed": "ace",
		"x-authorware-bin": [
			"aab",
			"x32",
			"u32",
			"vox"
		],
		"x-authorware-map": "aam",
		"x-authorware-seg": "aas",
		"x-blorb": ["blb", "blorb"],
		"x-bzip": "bz",
		"x-bzip2": ["bz2", "boz"],
		"x-cfs-compressed": "cfs",
		"x-chat": "chat",
		"x-conference": "nsc",
		"x-dgc-compressed": "dgc",
		"x-dtbncx+xml": "ncx",
		"x-dtbook+xml": "dtb",
		"x-dtbresource+xml": "res",
		"x-eva": "eva",
		"x-font-bdf": "bdf",
		"x-font-ghostscript": "gsf",
		"x-font-linux-psf": "psf",
		"x-font-pcf": "pcf",
		"x-font-snf": "snf",
		"x-font-ttf": ["ttf", "ttc"],
		"x-font-type1": [
			"pfa",
			"pfb",
			"pfm",
			"afm"
		],
		"x-freearc": "arc",
		"x-gca-compressed": "gca",
		"x-glulx": "ulx",
		"x-gramps-xml": "gramps",
		"x-install-instructions": "install",
		"x-lzh-compressed": ["lzh", "lha"],
		"x-mie": "mie",
		"x-mobipocket-ebook": ["prc", "mobi"],
		"x-ms-application": "application",
		"x-ms-shortcut": "lnk",
		"x-ms-xbap": "xbap",
		"x-msbinder": "obd",
		"x-mscardfile": "crd",
		"x-msclip": "clp",
		"application/x-ms-installer": "msi",
		"x-msmediaview": [
			"mvb",
			"m13",
			"m14"
		],
		"x-msmetafile": [
			"wmf",
			"wmz",
			"emf",
			"emz"
		],
		"x-msmoney": "mny",
		"x-mspublisher": "pub",
		"x-msschedule": "scd",
		"x-msterminal": "trm",
		"x-mswrite": "wri",
		"x-nzb": "nzb",
		"x-pkcs12": ["p12", "pfx"],
		"x-pkcs7-certificates": ["p7b", "spc"],
		"x-research-info-systems": "ris",
		"x-silverlight-app": "xap",
		"x-sql": "sql",
		"x-stuffitx": "sitx",
		"x-subrip": "srt",
		"x-t3vm-image": "t3",
		"x-tex-tfm": "tfm",
		"x-tgif": "obj",
		"x-xliff+xml": "xlf",
		"x-xz": "xz",
		"x-zmachine": [
			"z1",
			"z2",
			"z3",
			"z4",
			"z5",
			"z6",
			"z7",
			"z8"
		],
		"xaml+xml": "xaml",
		"xcap-diff+xml": "xdf",
		"xenc+xml": "xenc",
		"xml-dtd": "dtd",
		"xop+xml": "xop",
		"xproc+xml": "xpl",
		"xslt+xml": "xslt",
		"xv+xml": [
			"mxml",
			"xhvml",
			"xvml",
			"xvm"
		],
		"yang": "yang",
		"yin+xml": "yin",
		"envoy": "evy",
		"fractals": "fif",
		"internet-property-stream": "acx",
		"olescript": "axs",
		"vnd.ms-outlook": "msg",
		"vnd.ms-pkicertstore": "sst",
		"x-compress": "z",
		"x-perfmon": [
			"pma",
			"pmc",
			"pmr",
			"pmw"
		],
		"ynd.ms-pkipko": "pko",
		"gzip": ["gz", "tgz"],
		"smil+xml": ["smi", "smil"],
		"vnd.debian.binary-package": ["deb", "udeb"],
		"vnd.hzn-3d-crossword": "x3d",
		"vnd.sqlite3": [
			"db",
			"sqlite",
			"sqlite3",
			"db-wal",
			"sqlite-wal",
			"db-shm",
			"sqlite-shm"
		],
		"vnd.wap.sic": "sic",
		"vnd.wap.slc": "slc",
		"x-krita": ["kra", "krz"],
		"x-perl": ["pm", "pl"],
		"yaml": ["yaml", "yml"]
	},
	"audio": {
		"amr": "amr",
		"amr-wb": "awb",
		"annodex": "axa",
		"basic": ["au", "snd"],
		"flac": "flac",
		"midi": [
			"mid",
			"midi",
			"kar",
			"rmi"
		],
		"mpeg": [
			"mpga",
			"mpega",
			"mp3",
			"m4a",
			"mp2a",
			"m2a",
			"m3a"
		],
		"mpegurl": "m3u",
		"ogg": [
			"oga",
			"ogg",
			"spx"
		],
		"prs.sid": "sid",
		"x-aiff": "aifc",
		"x-gsm": "gsm",
		"x-ms-wma": "wma",
		"x-ms-wax": "wax",
		"x-pn-realaudio": "ram",
		"x-realaudio": "ra",
		"x-sd2": "sd2",
		"adpcm": "adp",
		"mp4": "mp4a",
		"s3m": "s3m",
		"silk": "sil",
		"vnd.dece.audio": ["uva", "uvva"],
		"vnd.digital-winds": "eol",
		"vnd.dra": "dra",
		"vnd.dts": "dts",
		"vnd.dts.hd": "dtshd",
		"vnd.lucent.voice": "lvp",
		"vnd.ms-playready.media.pya": "pya",
		"vnd.nuera.ecelp4800": "ecelp4800",
		"vnd.nuera.ecelp7470": "ecelp7470",
		"vnd.nuera.ecelp9600": "ecelp9600",
		"vnd.rip": "rip",
		"webm": "weba",
		"x-caf": "caf",
		"x-matroska": "mka",
		"x-pn-realaudio-plugin": "rmp",
		"xm": "xm",
		"aac": "aac",
		"aiff": [
			"aiff",
			"aif",
			"aff"
		],
		"opus": "opus",
		"wav": "wav"
	},
	"chemical": {
		"x-alchemy": "alc",
		"x-cache": ["cac", "cache"],
		"x-cache-csf": "csf",
		"x-cactvs-binary": [
			"cbin",
			"cascii",
			"ctab"
		],
		"x-cdx": "cdx",
		"x-chem3d": "c3d",
		"x-cif": "cif",
		"x-cmdf": "cmdf",
		"x-cml": "cml",
		"x-compass": "cpa",
		"x-crossfire": "bsd",
		"x-csml": ["csml", "csm"],
		"x-ctx": "ctx",
		"x-cxf": ["cxf", "cef"],
		"x-embl-dl-nucleotide": ["emb", "embl"],
		"x-gamess-input": [
			"inp",
			"gam",
			"gamin"
		],
		"x-gaussian-checkpoint": ["fch", "fchk"],
		"x-gaussian-cube": "cub",
		"x-gaussian-input": [
			"gau",
			"gjc",
			"gjf"
		],
		"x-gaussian-log": "gal",
		"x-gcg8-sequence": "gcg",
		"x-genbank": "gen",
		"x-hin": "hin",
		"x-isostar": ["istr", "ist"],
		"x-jcamp-dx": ["jdx", "dx"],
		"x-kinemage": "kin",
		"x-macmolecule": "mcm",
		"x-macromodel-input": "mmod",
		"x-mdl-molfile": "mol",
		"x-mdl-rdfile": "rd",
		"x-mdl-rxnfile": "rxn",
		"x-mdl-sdfile": "sd",
		"x-mdl-tgf": "tgf",
		"x-mmcif": "mcif",
		"x-mol2": "mol2",
		"x-molconn-Z": "b",
		"x-mopac-graph": "gpt",
		"x-mopac-input": [
			"mop",
			"mopcrt",
			"zmt"
		],
		"x-mopac-out": "moo",
		"x-ncbi-asn1": "asn",
		"x-ncbi-asn1-ascii": ["prt", "ent"],
		"x-ncbi-asn1-binary": "val",
		"x-rosdal": "ros",
		"x-swissprot": "sw",
		"x-vamas-iso14976": "vms",
		"x-vmd": "vmd",
		"x-xtel": "xtel",
		"x-xyz": "xyz"
	},
	"font": {
		"otf": "otf",
		"woff": "woff",
		"woff2": "woff2"
	},
	"image": {
		"gif": "gif",
		"ief": "ief",
		"jpeg": [
			"jpeg",
			"jpg",
			"jpe",
			"jfif",
			"jfif-tbnl",
			"jif"
		],
		"pcx": "pcx",
		"png": "png",
		"svg+xml": ["svg", "svgz"],
		"tiff": ["tiff", "tif"],
		"vnd.djvu": ["djvu", "djv"],
		"vnd.wap.wbmp": "wbmp",
		"x-canon-cr2": "cr2",
		"x-canon-crw": "crw",
		"x-cmu-raster": "ras",
		"x-coreldraw": "cdr",
		"x-coreldrawpattern": "pat",
		"x-coreldrawtemplate": "cdt",
		"x-corelphotopaint": "cpt",
		"x-epson-erf": "erf",
		"x-icon": "ico",
		"x-jg": "art",
		"x-jng": "jng",
		"x-nikon-nef": "nef",
		"x-olympus-orf": "orf",
		"x-portable-anymap": "pnm",
		"x-portable-bitmap": "pbm",
		"x-portable-graymap": "pgm",
		"x-portable-pixmap": "ppm",
		"x-rgb": "rgb",
		"x-xbitmap": "xbm",
		"x-xpixmap": "xpm",
		"x-xwindowdump": "xwd",
		"bmp": "bmp",
		"cgm": "cgm",
		"g3fax": "g3",
		"ktx": "ktx",
		"prs.btif": "btif",
		"sgi": "sgi",
		"vnd.dece.graphic": [
			"uvi",
			"uvvi",
			"uvg",
			"uvvg"
		],
		"vnd.dwg": "dwg",
		"vnd.dxf": "dxf",
		"vnd.fastbidsheet": "fbs",
		"vnd.fpx": "fpx",
		"vnd.fst": "fst",
		"vnd.fujixerox.edmics-mmr": "mmr",
		"vnd.fujixerox.edmics-rlc": "rlc",
		"vnd.ms-modi": "mdi",
		"vnd.ms-photo": "wdp",
		"vnd.net-fpx": "npx",
		"vnd.xiff": "xif",
		"webp": "webp",
		"x-3ds": "3ds",
		"x-cmx": "cmx",
		"x-freehand": [
			"fh",
			"fhc",
			"fh4",
			"fh5",
			"fh7"
		],
		"x-pict": ["pic", "pct"],
		"x-tga": "tga",
		"cis-cod": "cod",
		"avif": "avifs",
		"heic": ["heif", "heic"],
		"pjpeg": ["pjpg"],
		"vnd.adobe.photoshop": "psd",
		"x-adobe-dng": "dng",
		"x-fuji-raf": "raf",
		"x-icns": "icns",
		"x-kodak-dcr": "dcr",
		"x-kodak-k25": "k25",
		"x-kodak-kdc": "kdc",
		"x-minolta-mrw": "mrw",
		"x-panasonic-raw": [
			"raw",
			"rw2",
			"rwl"
		],
		"x-pentax-pef": ["pef", "ptx"],
		"x-sigma-x3f": "x3f",
		"x-sony-arw": "arw",
		"x-sony-sr2": "sr2",
		"x-sony-srf": "srf"
	},
	"message": { "rfc822": [
		"eml",
		"mime",
		"mht",
		"mhtml",
		"nws"
	] },
	"model": {
		"iges": ["igs", "iges"],
		"mesh": [
			"msh",
			"mesh",
			"silo"
		],
		"vrml": ["wrl", "vrml"],
		"x3d+vrml": ["x3dv", "x3dvz"],
		"x3d+xml": "x3dz",
		"x3d+binary": ["x3db", "x3dbz"],
		"vnd.collada+xml": "dae",
		"vnd.dwf": "dwf",
		"vnd.gdl": "gdl",
		"vnd.gtw": "gtw",
		"vnd.mts": "mts",
		"vnd.usdz+zip": "usdz",
		"vnd.vtu": "vtu"
	},
	"text": {
		"cache-manifest": ["manifest", "appcache"],
		"calendar": [
			"ics",
			"icz",
			"ifb"
		],
		"css": "css",
		"csv": "csv",
		"h323": "323",
		"html": [
			"html",
			"htm",
			"shtml",
			"stm"
		],
		"iuls": "uls",
		"plain": [
			"txt",
			"text",
			"brf",
			"conf",
			"def",
			"list",
			"log",
			"in",
			"bas",
			"diff",
			"ksh"
		],
		"richtext": "rtx",
		"scriptlet": ["sct", "wsc"],
		"texmacs": "tm",
		"tab-separated-values": "tsv",
		"vnd.sun.j2me.app-descriptor": "jad",
		"vnd.wap.wml": "wml",
		"vnd.wap.wmlscript": "wmls",
		"x-bibtex": "bib",
		"x-boo": "boo",
		"x-c++hdr": [
			"h++",
			"hpp",
			"hxx",
			"hh"
		],
		"x-c++src": [
			"c++",
			"cpp",
			"cxx",
			"cc"
		],
		"x-component": "htc",
		"x-dsrc": "d",
		"x-diff": "patch",
		"x-haskell": "hs",
		"x-java": "java",
		"x-literate-haskell": "lhs",
		"x-moc": "moc",
		"x-pascal": [
			"p",
			"pas",
			"pp",
			"inc"
		],
		"x-pcs-gcd": "gcd",
		"x-python": "py",
		"x-scala": "scala",
		"x-setext": "etx",
		"x-tcl": ["tcl", "tk"],
		"x-tex": [
			"tex",
			"ltx",
			"sty",
			"cls"
		],
		"x-vcalendar": "vcs",
		"x-vcard": "vcf",
		"n3": "n3",
		"prs.lines.tag": "dsc",
		"sgml": ["sgml", "sgm"],
		"troff": [
			"t",
			"tr",
			"roff",
			"man",
			"me",
			"ms"
		],
		"turtle": "ttl",
		"uri-list": [
			"uri",
			"uris",
			"urls"
		],
		"vcard": "vcard",
		"vnd.curl": "curl",
		"vnd.curl.dcurl": "dcurl",
		"vnd.curl.scurl": "scurl",
		"vnd.curl.mcurl": "mcurl",
		"vnd.dvb.subtitle": "sub",
		"vnd.fly": "fly",
		"vnd.fmi.flexstor": "flx",
		"vnd.graphviz": "gv",
		"vnd.in3d.3dml": "3dml",
		"vnd.in3d.spot": "spot",
		"x-asm": ["s", "asm"],
		"x-c": [
			"c",
			"h",
			"dic"
		],
		"x-fortran": [
			"f",
			"for",
			"f77",
			"f90"
		],
		"x-opml": "opml",
		"x-nfo": "nfo",
		"x-sfv": "sfv",
		"x-uuencode": "uu",
		"webviewhtml": "htt",
		"javascript": "js",
		"json": "json",
		"markdown": [
			"md",
			"markdown",
			"mdown",
			"markdn"
		],
		"vnd.wap.si": "si",
		"vnd.wap.sl": "sl"
	},
	"video": {
		"avif": "avif",
		"3gpp": "3gp",
		"annodex": "axv",
		"dl": "dl",
		"dv": ["dif", "dv"],
		"fli": "fli",
		"gl": "gl",
		"mpeg": [
			"mpeg",
			"mpg",
			"mpe",
			"m1v",
			"m2v",
			"mp2",
			"mpa",
			"mpv2"
		],
		"mp4": [
			"mp4",
			"mp4v",
			"mpg4"
		],
		"quicktime": ["qt", "mov"],
		"ogg": "ogv",
		"vnd.mpegurl": ["mxu", "m4u"],
		"x-flv": "flv",
		"x-la-asf": ["lsf", "lsx"],
		"x-mng": "mng",
		"x-ms-asf": [
			"asf",
			"asx",
			"asr"
		],
		"x-ms-wm": "wm",
		"x-ms-wmv": "wmv",
		"x-ms-wmx": "wmx",
		"x-ms-wvx": "wvx",
		"x-msvideo": "avi",
		"x-sgi-movie": "movie",
		"x-matroska": [
			"mpv",
			"mkv",
			"mk3d",
			"mks"
		],
		"3gpp2": "3g2",
		"h261": "h261",
		"h263": "h263",
		"h264": "h264",
		"jpeg": "jpgv",
		"jpm": ["jpm", "jpgm"],
		"mj2": ["mj2", "mjp2"],
		"vnd.dece.hd": ["uvh", "uvvh"],
		"vnd.dece.mobile": ["uvm", "uvvm"],
		"vnd.dece.pd": ["uvp", "uvvp"],
		"vnd.dece.sd": ["uvs", "uvvs"],
		"vnd.dece.video": ["uvv", "uvvv"],
		"vnd.dvb.file": "dvb",
		"vnd.fvt": "fvt",
		"vnd.ms-playready.media.pyv": "pyv",
		"vnd.uvvu.mp4": ["uvu", "uvvu"],
		"vnd.vivo": "viv",
		"webm": "webm",
		"x-f4v": "f4v",
		"x-m4v": "m4v",
		"x-ms-vob": "vob",
		"x-smv": "smv",
		"mp2t": "ts"
	},
	"x-conference": { "x-cooltalk": "ice" },
	"x-world": { "x-vrml": [
		"vrm",
		"flr",
		"wrz",
		"xaf",
		"xof"
	] }
};
(() => {
	const mimeTypes = {};
	for (const type of Object.keys(table)) for (const subtype of Object.keys(table[type])) {
		const value = table[type][subtype];
		if (typeof value == "string") mimeTypes[value] = type + "/" + subtype;
		else for (let indexMimeType = 0; indexMimeType < value.length; indexMimeType++) mimeTypes[value[indexMimeType]] = type + "/" + subtype;
	}
	return mimeTypes;
})();
//#endregion
//#region node_modules/@zip.js/zip.js/lib/zip-fs-wasm.js
t(configure);
//#endregion
//#region src/factory.ts
const BOOT_CRITICAL_IMAGES = [
	"boot",
	"dt",
	"dtbo",
	"init_boot",
	"pvmfw",
	"recovery",
	"vbmeta_system",
	"vbmeta_vendor",
	"vbmeta",
	"vendor_boot",
	"vendor_kernel_boot"
];
const SYSTEM_IMAGES = [
	"odm",
	"odm_dlkm",
	"product",
	"system_dlkm",
	"system_ext",
	"system",
	"vendor_dlkm",
	"vendor"
];
/**
* User-friendly action strings for factory image flashing progress.
* This can be indexed by the action argument in FactoryFlashCallback.
*/
const USER_ACTION_MAP = {
	load: "Loading",
	unpack: "Unpacking",
	flash: "Writing",
	wipe: "Wiping",
	reboot: "Restarting"
};
const BOOTLOADER_REBOOT_TIME = 4e3;
const FASTBOOTD_REBOOT_TIME = 16e3;
const USERDATA_ERASE_TIME = 1e3;
async function zipGetData(entry, writer, options) {
	try {
		return await entry.getData(writer, options);
	} catch (e) {
		if (e instanceof ProgressEvent && e.type === "error" && e.target !== null) throw e.target.error;
		else throw e;
	}
}
function isFileEntry(entry) {
	return !entry.directory;
}
async function flashEntryBlob(device, entry, onProgress, partition, slot = "current") {
	logDebug(`Unpacking ${partition}`);
	onProgress("unpack", partition, 0);
	let blob = await zipGetData(entry, new BlobWriter("application/octet-stream"), { onprogress: (bytes, len) => {
		onProgress("unpack", partition, bytes / len);
	} });
	logDebug(`Flashing ${partition}`);
	onProgress("flash", partition, 0);
	await device.flashBlob(partition, slot, blob, (progress) => {
		onProgress("flash", partition, progress);
	});
}
async function tryFlashImages(device, entries, onProgress, imageNames, slot = "current") {
	for (let imageName of imageNames) {
		let pattern = new RegExp(`${imageName}(?:-.+)?\\.img$`);
		let entry = entries.find((entry) => entry.filename.match(pattern));
		if (entry !== void 0) await flashEntryBlob(device, entry, onProgress, imageName, slot);
	}
}
async function checkRequirements(device, androidInfo) {
	for (let line of androidInfo.replace("\r", "").split("\n")) {
		let match = line.match(/^require\s+(.+?)=(.+)$/);
		if (!match) continue;
		let variable = match[1];
		if (variable === "board") variable = "product";
		let expectValue = match[2];
		let expectValues = expectValue.split("|");
		if (variable === "partition-exists") {
			let hasSlot = await device.getVariable(`has-slot:${expectValue}`);
			if (hasSlot !== "yes" && hasSlot !== "no") throw new FastbootError("FAIL", `Requirement ${variable}=${expectValue} failed, device lacks partition`);
			if (!BOOT_CRITICAL_IMAGES.includes(expectValue) && !SYSTEM_IMAGES.includes(expectValue)) throw new FastbootError("FAIL", `Requirement ${variable}=${expectValue} failed, unrecognized partition`);
		} else {
			let realValue = await device.getVariable(variable);
			if (expectValues.includes(realValue)) logDebug(`Requirement ${variable}=${expectValue} passed`);
			else {
				let msg = `Requirement ${variable}=${expectValue} failed, value = ${realValue}`;
				logDebug(msg);
				throw new FastbootError("FAIL", msg);
			}
		}
	}
}
async function tryRebootWithSlotSwitch(device, target, onReconnect) {
	try {
		await device.rebootSwitchSlot(target, false);
	} catch (e) {}
	await device.waitForConnect(onReconnect);
}
async function flashZip(device, blob, wipe, onReconnect, onProgress = (_action, _item, _progress) => {}) {
	onProgress("load", "package", 0);
	let entries = (await new ZipReader(new BlobReader(blob)).getEntries()).filter(isFileEntry);
	let avbCustomKeyEntry = entries.find((e) => e.filename.endsWith("avb_custom_key.img"));
	if (avbCustomKeyEntry === void 0) throw new Error("avb_custom_key.img not found! bootloader locking would fail.");
	if (await device.getVariable("is-userspace") === "yes") await device.reboot("bootloader", true, onReconnect);
	await tryFlashImages(device, entries, onProgress, ["bootloader"], "other");
	await runWithTimedProgress(onProgress, "reboot", "device", BOOTLOADER_REBOOT_TIME, tryRebootWithSlotSwitch(device, "bootloader", onReconnect));
	await tryFlashImages(device, entries, onProgress, ["bootloader"], "other");
	await runWithTimedProgress(onProgress, "reboot", "device", BOOTLOADER_REBOOT_TIME, tryRebootWithSlotSwitch(device, "bootloader", onReconnect));
	await tryFlashImages(device, entries, onProgress, ["radio"], "other");
	await runWithTimedProgress(onProgress, "reboot", "device", BOOTLOADER_REBOOT_TIME, tryRebootWithSlotSwitch(device, "bootloader", onReconnect));
	await tryFlashImages(device, entries, onProgress, ["radio"], "other");
	await runWithTimedProgress(onProgress, "reboot", "device", BOOTLOADER_REBOOT_TIME, tryRebootWithSlotSwitch(device, "bootloader", onReconnect));
	let snapshotStatus = await device.getVariable("snapshot-update-status");
	if (snapshotStatus !== null && snapshotStatus !== "none") await device.runCommand("snapshot-update:cancel");
	logDebug("Loading nested images from zip");
	onProgress("unpack", "images", 0);
	let entry = entries.find((e) => e.filename.match(/image-.+\.zip$/));
	let imageEntries = (await new ZipReader(new BlobReader(await zipGetData(entry, new BlobWriter("application/zip"), { onprogress: (bytes, len) => {
		onProgress("unpack", "images", bytes / len);
	} }))).getEntries()).filter(isFileEntry);
	await device.runCommand("erase:avb_custom_key");
	await flashEntryBlob(device, avbCustomKeyEntry, onProgress, "avb_custom_key");
	entry = imageEntries.find((e) => e.filename === "android-info.txt");
	if (entry !== void 0) await checkRequirements(device, await zipGetData(entry, new TextWriter()));
	await tryFlashImages(device, imageEntries, onProgress, BOOT_CRITICAL_IMAGES);
	entry = imageEntries.find((e) => e.filename === "super_empty.img");
	if (entry !== void 0) {
		await runWithTimedProgress(onProgress, "reboot", "device", FASTBOOTD_REBOOT_TIME, device.reboot("fastboot", true, onReconnect));
		let superName = await device.getVariable("super-partition-name");
		if (!superName) superName = "super";
		let superAction = wipe ? "wipe" : "flash";
		onProgress(superAction, "super", 0);
		let superBlob = await zipGetData(entry, new BlobWriter("application/octet-stream"));
		await device.upload(superName, await readBlobAsBuffer(superBlob), (progress) => {
			onProgress(superAction, "super", progress);
		});
		await device.runCommand(`update-super:${superName}${wipe ? ":wipe" : ""}`);
	}
	await tryFlashImages(device, imageEntries, onProgress, SYSTEM_IMAGES);
	if (await device.getVariable("is-userspace") === "yes") await runWithTimedProgress(onProgress, "reboot", "device", BOOTLOADER_REBOOT_TIME, device.reboot("bootloader", true, onReconnect));
	if (wipe) await runWithTimedProgress(onProgress, "wipe", "data", USERDATA_ERASE_TIME, device.runCommand("erase:userdata"));
}
//#endregion
//#region src/fastboot.ts
const FASTBOOT_USB_CLASS = 255;
const FASTBOOT_USB_SUBCLASS = 66;
const FASTBOOT_USB_PROTOCOL = 3;
const BULK_TRANSFER_SIZE = 16384;
const DEFAULT_DOWNLOAD_SIZE = 512 * 1024 * 1024;
const MAX_DOWNLOAD_SIZE = 1024 * 1024 * 1024;
const GETVAR_TIMEOUT = 1e4;
/**
* This class is a client for executing fastboot commands and operations on a
* device connected over USB.
*/
var FastbootDevice = class {
	device;
	epIn;
	epOut;
	_registeredUsbListeners;
	_connectResolve;
	_connectReject;
	_disconnectResolve;
	/**
	* Create a new fastboot device instance. This doesn't actually connect to
	* any USB devices; call {@link connect} to do so.
	*/
	constructor() {
		this.device = null;
		this.epIn = null;
		this.epOut = null;
		this._registeredUsbListeners = false;
		this._connectResolve = null;
		this._connectReject = null;
		this._disconnectResolve = null;
	}
	/**
	* Returns whether a USB device is connected and ready for use.
	*/
	get isConnected() {
		return this.device !== null && this.device.opened && this.device.configurations[0].interfaces[0].claimed;
	}
	/**
	* Validate the current USB device's details and connect to it.
	*
	* @private
	*/
	async _validateAndConnectDevice() {
		if (this.device === null) throw new UsbError("Attempted to connect to null device");
		let ife = this.device.configurations[0].interfaces[0].alternates[0];
		if (ife.endpoints.length !== 2) throw new UsbError("Interface has wrong number of endpoints");
		this.epIn = null;
		this.epOut = null;
		for (let endpoint of ife.endpoints) {
			logVerbose(`Checking endpoint: endpointNumber=${endpoint.endpointNumber}, direction=${endpoint.direction}, type=${endpoint.type}, packetSize=${endpoint.packetSize}`);
			if (endpoint.type !== "bulk") throw new UsbError("Interface endpoint is not bulk");
			if (endpoint.direction === "in") if (this.epIn === null) this.epIn = endpoint.endpointNumber;
			else throw new UsbError("Interface has multiple IN endpoints");
			else if (endpoint.direction === "out") if (this.epOut === null) this.epOut = endpoint.endpointNumber;
			else throw new UsbError("Interface has multiple OUT endpoints");
		}
		logVerbose("Endpoints: in=", this.epIn, ", out=", this.epOut);
		try {
			await this.device.open();
			try {
				await this.device.reset();
			} catch (error) {}
			await this.device.selectConfiguration(1);
			await this.device.claimInterface(0);
		} catch (error) {
			if (this._connectReject !== null) {
				this._connectReject(error);
				this._connectResolve = null;
				this._connectReject = null;
			}
			throw error;
		}
		if (this._connectResolve !== null) {
			this._connectResolve(void 0);
			this._connectResolve = null;
			this._connectReject = null;
		}
	}
	/**
	* Wait for the current USB device to disconnect, if it's still connected.
	* Returns immediately if no device is connected.
	*/
	async waitForDisconnect() {
		if (this.device === null) return;
		return await new Promise((resolve, _reject) => {
			this._disconnectResolve = resolve;
		});
	}
	/**
	* Wait for the USB device to connect. Returns at the next connection,
	* regardless of whether the connected USB device matches the previous one.
	*
	* @param {ReconnectCallback} onReconnect - Callback to request device reconnection on Android.
	*/
	async waitForConnect(onReconnect = () => {}) {
		if (navigator.userAgent.includes("Android")) {
			await this.waitForDisconnect();
			onReconnect();
		}
		return await new Promise((resolve, reject) => {
			this._connectResolve = resolve;
			this._connectReject = reject;
		});
	}
	/**
	* Request the user to select a USB device and connect to it using the
	* fastboot protocol.
	*
	* @throws {UsbError}
	*/
	async connect() {
		this.device = await navigator.usb.requestDevice({ filters: [{
			classCode: FASTBOOT_USB_CLASS,
			subclassCode: FASTBOOT_USB_SUBCLASS,
			protocolCode: FASTBOOT_USB_PROTOCOL
		}] });
		logDebug("Using USB device:", this.device);
		if (!this._registeredUsbListeners) {
			navigator.usb.addEventListener("disconnect", (event) => {
				if (event.device === this.device) {
					logDebug("USB device disconnected");
					if (this._disconnectResolve !== null) {
						this._disconnectResolve(void 0);
						this._disconnectResolve = null;
					}
				}
			});
			navigator.usb.addEventListener("connect", async (event) => {
				logDebug("USB device connected");
				this.device = event.device;
				let hasPromiseReject = this._connectReject !== null;
				try {
					await this._validateAndConnectDevice();
				} catch (error) {
					if (!hasPromiseReject) throw error;
				}
			});
			this._registeredUsbListeners = true;
		}
		await this._validateAndConnectDevice();
	}
	/**
	* Read a raw command response from the bootloader.
	*
	* @private
	* @returns {Promise<CommandResponse>} Object containing response text and data size, if any.
	* @throws {FastbootError}
	*/
	async _readResponse() {
		let respData = { text: "" };
		let respStatus;
		do {
			let respPacket = await this.device.transferIn(this.epIn, 64);
			let response = new TextDecoder().decode(respPacket.data);
			respStatus = response.substring(0, 4);
			let respMessage = response.substring(4);
			logDebug(`Response: ${respStatus} ${respMessage}`);
			if (respStatus === "OKAY") respData.text += respMessage;
			else if (respStatus === "INFO") respData.text += respMessage + "\n";
			else if (respStatus === "DATA") respData.dataSize = respMessage;
			else throw new FastbootError(respStatus, respMessage);
		} while (respStatus === "INFO");
		return respData;
	}
	/**
	* Send a textual command to the bootloader and read the response.
	* This is in raw fastboot format, not AOSP fastboot syntax.
	*
	* @param {string} command - The command to send.
	* @returns {Promise<CommandResponse>} Object containing response text and data size, if any.
	* @throws {FastbootError}
	*/
	async runCommand(command) {
		if (command.length > 64) throw new RangeError();
		let cmdPacket = new TextEncoder().encode(command);
		await this.device.transferOut(this.epOut, cmdPacket);
		logDebug("Command:", command);
		return this._readResponse();
	}
	/**
	* Read the value of a bootloader variable. Returns undefined if the variable
	* does not exist.
	*
	* @param {string} varName - The name of the variable to get.
	* @returns {Promise<string>} Textual content of the variable.
	* @throws {FastbootError}
	*/
	async getVariable(varName) {
		let resp;
		try {
			resp = (await runWithTimeout(this.runCommand(`getvar:${varName}`), GETVAR_TIMEOUT)).text;
		} catch (error) {
			if (error instanceof FastbootError && error.status == "FAIL") resp = null;
			else throw error;
		}
		return resp ? resp.trim() : null;
	}
	/**
	* Get the maximum download size for a single payload, in bytes.
	*
	* @private
	* @returns {Promise<number>}
	* @throws {FastbootError}
	*/
	async _getDownloadSize() {
		try {
			let resp = (await this.getVariable("max-download-size")).toLowerCase();
			if (resp) return Math.min(parseInt(resp, 16), MAX_DOWNLOAD_SIZE);
		} catch (error) {}
		return DEFAULT_DOWNLOAD_SIZE;
	}
	/**
	* Send a raw data payload to the bootloader.
	*
	* @private
	*/
	async _sendRawPayload(buffer, onProgress) {
		let i = 0;
		let remainingBytes = buffer.byteLength;
		while (remainingBytes > 0) {
			let chunk = buffer.slice(i * BULK_TRANSFER_SIZE, (i + 1) * BULK_TRANSFER_SIZE);
			if (i % 1e3 === 0) logVerbose(`  Sending ${chunk.byteLength} bytes to endpoint, ${remainingBytes} remaining, i=${i}`);
			if (i % 10 === 0) onProgress((buffer.byteLength - remainingBytes) / buffer.byteLength);
			await this.device.transferOut(this.epOut, chunk);
			remainingBytes -= chunk.byteLength;
			i += 1;
		}
		onProgress(1);
	}
	/**
	* Upload a payload to the bootloader for later use, e.g. flashing.
	* Does not handle raw images, flashing, or splitting.
	*
	* @param {string} partition - Name of the partition the payload is intended for.
	* @param {ArrayBuffer} buffer - Buffer containing the data to upload.
	* @param {FlashProgressCallback} onProgress - Callback for upload progress updates.
	* @throws {FastbootError}
	*/
	async upload(partition, buffer, onProgress = (_progress) => {}) {
		logDebug(`Uploading single sparse to ${partition}: ${buffer.byteLength} bytes`);
		let xferHex = buffer.byteLength.toString(16).padStart(8, "0");
		if (xferHex.length !== 8) throw new FastbootError("FAIL", `Transfer size overflow: ${xferHex} is more than 8 digits`);
		let downloadResp = await this.runCommand(`download:${xferHex}`);
		if (downloadResp.dataSize === void 0) throw new FastbootError("FAIL", `Unexpected response to download command: ${downloadResp.text}`);
		let downloadSize = parseInt(downloadResp.dataSize, 16);
		if (downloadSize !== buffer.byteLength) throw new FastbootError("FAIL", `Bootloader wants ${downloadSize} bytes, requested to send ${buffer.byteLength} bytes`);
		logDebug(`Sending payload: ${buffer.byteLength} bytes`);
		await this._sendRawPayload(buffer, onProgress);
		logDebug("Payload sent, waiting for response...");
		await this._readResponse();
	}
	/**
	* Reboot to the given target, and optionally wait for the device to
	* reconnect.
	*
	* @param {string} target - Where to reboot to, i.e. fastboot or bootloader.
	* @param {boolean} wait - Whether to wait for the device to reconnect.
	* @param {ReconnectCallback} onReconnect - Callback to request device reconnection, if wait is enabled.
	*/
	async reboot(target = "", wait = false, onReconnect = () => {}) {
		if (target.length > 0) await this.runCommand(`reboot-${target}`);
		else await this.runCommand("reboot");
		if (wait) await this.waitForConnect(onReconnect);
	}
	/**
	* Reboot to the given target and switch slot, and optionally wait for the device to
	* reconnect.
	*
	* @param {string} target - Where to reboot to, i.e. fastboot or bootloader.
	* @param {boolean} wait - Whether to wait for the device to reconnect.
	* @param {ReconnectCallback} onReconnect - Callback to request device reconnection, if wait is enabled.
	*/
	async rebootSwitchSlot(target = "", wait = false, onReconnect = () => {}) {
		let otherSlot = await this.getOtherSlot();
		await this.runCommand(`set_active:${otherSlot}`);
		if (target.length > 0) await this.runCommand(`reboot-${target}`);
		else await this.runCommand("reboot");
		if (wait) await this.waitForConnect(onReconnect);
	}
	/**
	* Flash the given Blob to the given partition and slot on the device. Any image
	* format supported by the bootloader is allowed, e.g. sparse or raw images.
	* Large raw images will be converted to sparse images automatically, and
	* large sparse images will be split and flashed in multiple passes
	* depending on the bootloader's payload size limit.
	*
	* @param {string} partition - The name of the partition to flash.
	* @param {string} slot - The slot to flash, defaults to current
	* @param {Blob} blob - The Blob to retrieve data from.
	* @param {FlashProgressCallback} onProgress - Callback for flashing progress updates.
	* @throws {FastbootError}
	*/
	async flashBlob(partition, slot = "current", blob, onProgress = (_progress) => {}) {
		if (await this.getVariable(`has-slot:${partition}`) === "yes") {
			let currentSlot = await this.getVariable("current-slot");
			if (slot === "current") partition += "_" + currentSlot;
			else if (slot === "other") {
				let otherSlot = await this.getOtherSlot();
				partition += "_" + otherSlot;
			} else if (slot === "a" || slot === "b") partition += "_" + slot;
			else throw new FastbootError("FAIL", `Unknown Slot: ${slot}`);
		}
		logDebug(`Flashing partition ${partition}`);
		let maxDlSize = await this._getDownloadSize();
		let fileHeader = await readBlobAsBuffer(blob.slice(0, 28));
		let totalBytes = blob.size;
		let isSparse = false;
		try {
			let sparseHeader = parseFileHeader(fileHeader);
			if (sparseHeader !== null) {
				totalBytes = sparseHeader.blocks * sparseHeader.blockSize;
				isSparse = true;
			}
		} catch (error) {}
		if (await this.getVariable(`is-logical:${partition}`) === "yes") {
			await this.runCommand(`resize-logical-partition:${partition}:0`);
			await this.runCommand(`resize-logical-partition:${partition}:${totalBytes}`);
		}
		if (blob.size > maxDlSize && !isSparse) {
			logDebug(`${partition} image is raw, converting to sparse`);
			blob = await fromRaw(blob);
		}
		logDebug(`Flashing ${blob.size} bytes to ${partition}, ${maxDlSize} bytes per split`);
		let splits = 0;
		let sentBytes = 0;
		for await (let split of splitBlob(blob, maxDlSize)) {
			await this.upload(partition, split.data, (progress) => {
				onProgress((sentBytes + progress * split.bytes) / totalBytes);
			});
			logDebug("Flashing payload...");
			await this.runCommand(`flash:${partition}`);
			splits += 1;
			sentBytes += split.bytes;
		}
		logDebug(`Flashed ${partition} with ${splits} split(s)`);
	}
	/**
	* Boot the given Blob on the device.
	* Equivalent to `fastboot boot boot.img`.
	*
	* @param {Blob} blob - The Blob to retrieve data from.
	* @param {FlashProgressCallback} onProgress - Callback for flashing progress updates.
	* @throws {FastbootError}
	*/
	async bootBlob(blob, onProgress = (_progress) => {}) {
		logDebug(`Booting ${blob.size} bytes image`);
		let data = await readBlobAsBuffer(blob);
		await this.upload("boot.img", data, onProgress);
		logDebug("Booting payload...");
		await this.runCommand("boot");
		logDebug(`Booted ${blob.size} bytes image`);
	}
	/**
	* Flash the given factory images zip onto the device, with automatic handling
	* of firmware, system, and logical partitions as AOSP fastboot and
	* flash-all.sh would do.
	* Equivalent to `fastboot update name.zip`.
	*
	* @param {Blob} blob - Blob containing the zip file to flash.
	* @param {boolean} wipe - Whether to wipe super and userdata. Equivalent to `fastboot -w`.
	* @param {ReconnectCallback} onReconnect - Callback to request device reconnection.
	* @param {FactoryProgressCallback} onProgress - Progress callback for image flashing.
	*/
	async flashFactoryZip(blob, wipe, onReconnect, onProgress = (_progress) => {}) {
		return await flashZip(this, blob, wipe, onReconnect, onProgress);
	}
	/**
	* Wipe the super partition by flashing a minimal sparse image derived from
	* the LP metadata in the given super_empty.img Blob.  This erases all logical
	* partition data and resets the partition table to the empty layout encoded
	* in the image.
	*
	* The device must be in the bootloader (not fastbootd) when this is called.
	*
	* @param {Blob} blob - Blob containing super_empty.img.
	* @param {string} slot - The slot to target ("current", "a", or "b").
	* @param {FlashProgressCallback} onProgress - Callback for flashing progress updates.
	* @throws {FastbootError}
	*/
	async wipeSuper(blob, slot = "current", onProgress = (_progress) => {}) {
		const metadata = await readFromImageBlob(blob);
		let resolvedSlot = slot;
		if (slot === "current") resolvedSlot = await this.getVariable("current-slot") ?? "a";
		else if (slot === "other") resolvedSlot = await this.getOtherSlot();
		logDebug(`Targeting slot "${resolvedSlot}"`);
		const images = await buildWipeSuperImages(metadata);
		const superDevice = getMetadataSuperBlockDevice(metadata);
		if (superDevice !== null && getBlockDevicePartitionName(superDevice) !== "super") try {
			await this.runCommand("oem allow-flash-super");
		} catch {}
		for (const image of images) {
			let flashPartition = image.partitionName;
			if (await this.getVariable(`has-slot:${image.partitionName}`) === "yes") flashPartition = `${image.partitionName}_${resolvedSlot}`;
			else if (image.forceSlot) logDebug(`Warning: ${image.partitionName} does not support slots but slot suffix was requested`);
			logDebug(`Flashing ${image.data.byteLength} bytes to "${flashPartition}"`);
			await this.upload(flashPartition, image.data, onProgress);
			await this.runCommand(`flash:${flashPartition}`);
		}
		logDebug("Wipe super Done");
	}
	/**
	* Determine the other slot
	* Hardcoded for A/B currently as that's what we mostly have in the field
	*
	*/
	async getOtherSlot() {
		let currentSlot = await this.getVariable("current-slot");
		if (currentSlot === "a") return "b";
		else if (currentSlot === "b") return "a";
		else throw new FastbootError("FAIL", `Unable to determine other slot, current slot: ${currentSlot}`);
	}
};
//#endregion
//#region src/index.ts
// @license-end
//#endregion
export { FastbootDevice, FastbootError, ImageError, LpError, TimeoutError, USER_ACTION_MAP, UsbError, buildWipeSuperImages, configure as configureZip, getBlockDevicePartitionName, getMetadataSuperBlockDevice, readFromImageBlob, setDebugLevel, setDebugLogger };

//# sourceMappingURL=fastboot.mjs.map