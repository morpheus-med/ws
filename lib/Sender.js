/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var events = require('events')
  , util = require('util')
  , EventEmitter = events.EventEmitter
  , ErrorCodes = require('./ErrorCodes')
  , bufferUtil = require('./BufferUtil').BufferUtil;

/**
 * HyBi Sender implementation
 */

function Sender(socket) {
  this._socket = socket;
  this.firstFragment = true;
}

/**
 * Inherits from EventEmitter.
 */

util.inherits(Sender, events.EventEmitter);

/**
 * Sends a close instruction to the remote party.
 *
 * @api public
 */

Sender.prototype.close = function(code, data, mask) {
  if (typeof code !== 'undefined') {
    if (typeof code !== 'number' ||
      !ErrorCodes.isValidErrorCode(code)) throw new Error('first argument must be a valid error code number');
  }
  code = code || 1000;
  var dataBuffer = new Buffer(2 + (data ? Buffer.byteLength(data) : 0));
  writeUInt16BE.call(dataBuffer, code, 0);
  if (dataBuffer.length > 2) dataBuffer.write(data, 2);
  this.frameAndSend(0x8, dataBuffer, true, mask);
};

/**
 * Sends a ping message to the remote party.
 *
 * @api public
 */

Sender.prototype.ping = function(data, options) {
  var mask = options && options.mask;
  this.frameAndSend(0x9, data || '', true, mask);
};

/**
 * Sends a pong message to the remote party.
 *
 * @api public
 */

Sender.prototype.pong = function(data, options) {
  var mask = options && options.mask;
  this.frameAndSend(0xa, data || '', true, mask);
};

/**
 * Sends text or binary data to the remote party.
 *
 * @api public
 */

Sender.prototype.send = function(data, options, cb) {
  var finalFragment = options && options.fin === false ? false : true;
  var mask = options && options.mask;
  var opcode = options && options.binary ? 2 : 1;
  var compress = options && options.compress;
  if (this.firstFragment === false) opcode = 0;
  else this.firstFragment = false;
  if (finalFragment) this.firstFragment = true
  this.frameAndSend(opcode, data, finalFragment, mask, compress, cb);
};

/**
 * Frames and sends a piece of data according to the HyBi WebSocket protocol.
 *
 * @api private
 */

Sender.prototype.frameAndSend = function(opcode, message_data, finalFragment, maskData, compress, cb) {
  var canModifyData = false;

  if (!message_data) {
    try {
      this._socket.write(new Buffer([opcode | (finalFragment ? 0x80 : 0), 0 | (maskData ? 0x80 : 0)].concat(maskData ? [0, 0, 0, 0] : [])), 'binary', cb);
    }
    catch (e) {
      if (typeof cb == 'function') cb(e);
      else this.emit('error', e);
    }
    return;
  }

  if (!Buffer.isBuffer(message_data)) {
    canModifyData = true;
    if (message_data && (typeof message_data.byteLength !== 'undefined' || typeof message_data.buffer !== 'undefined')) {
      message_data = getArrayBuffer(message_data);
    } else {
      message_data = new Buffer(message_data);
    }
  }

  var self = this;

  var _frame_and_send = function(data) {
    var dataLength = data.length
      , dataOffset = maskData ? 6 : 2
      , secondByte = dataLength;

    if (dataLength >= 65536) {
      dataOffset += 8;
      secondByte = 127;
    }
    else if (dataLength > 125) {
      dataOffset += 2;
      secondByte = 126;
    }

    var mergeBuffers = dataLength < 32768 || (maskData && !canModifyData);
    var totalLength = mergeBuffers ? dataLength + dataOffset : dataOffset;
    var outputBuffer = new Buffer(totalLength);
    outputBuffer[0] = finalFragment ? opcode | 0x80 : opcode;
    
    if(compress)
      outputBuffer[0] |= 0x40;

    switch (secondByte) {
      case 126:
        writeUInt16BE.call(outputBuffer, dataLength, 2);
        break;
      case 127:
        writeUInt32BE.call(outputBuffer, 0, 2);
        writeUInt32BE.call(outputBuffer, dataLength, 6);
    }

    if (maskData) {
      outputBuffer[1] = secondByte | 0x80;
      var mask = self._randomMask || (self._randomMask = getRandomMask());
      outputBuffer[dataOffset - 4] = mask[0];
      outputBuffer[dataOffset - 3] = mask[1];
      outputBuffer[dataOffset - 2] = mask[2];
      outputBuffer[dataOffset - 1] = mask[3];
      if (mergeBuffers) {
        bufferUtil.mask(data, mask, outputBuffer, dataOffset, dataLength);
        try {
          self._socket.write(outputBuffer, 'binary', cb);
        }
        catch (e) {
          if (typeof cb == 'function') cb(e);
          else self.emit('error', e);
        }
      }
      else {
        bufferUtil.mask(data, mask, data, 0, dataLength);
        try {
          self._socket.write(outputBuffer, 'binary');
          self._socket.write(data, 'binary', cb);
        }
        catch (e) {
          if (typeof cb == 'function') cb(e);
          else self.emit('error', e);
        }
      }
    }
    else {
      outputBuffer[1] = secondByte;
      if (mergeBuffers) {
        data.copy(outputBuffer, dataOffset);
        try {
          self._socket.write(outputBuffer, 'binary', cb);
        }
        catch (e) {
          if (typeof cb == 'function') cb(e);
          else self.emit('error', e);
        }
      }
      else {
        try {
          self._socket.write(outputBuffer, 'binary');
          self._socket.write(data, 'binary', cb);
        }
        catch (e) {
          if (typeof cb == 'function') cb(e);
          else self.emit('error', e);
        }
      }
    }    
  };

    //-----------------------------------------------------------------------------------
    // hybi-17 with permessage-deflate requires:
    //
    // compress data with deflateRaw
    //
    // if result does not end with an empty DEFLATE block
    // with no compression (the "BTYPE" bits are set to 00), append an
    // empty DEFLATE block with no compression to the tail end.
    //
    // remove 0x00 0x00 0xff 0xff from tail
  var zlib = require('zlib');
    
  if(compress) {
    var deflate_stream = new zlib.DeflateRaw({ flush : zlib.Z_SYNC_FLUSH });
    var cdata = new Buffer(0);
    deflate_stream.on('error', function(err) {
      throw new Error(err);
    });
    deflate_stream.on('data', function(chunk) {
      cdata = Buffer.concat([cdata, chunk]);
    });
    deflate_stream.on('end', function() {
      // zlib with Z_SYNC_FLUSH ends with empty deflate block and 0x30 0x00
      // so we remove 6 bytes 0x00 0x00 0xff 0xff 0x30 0x00
      _frame_and_send(cdata.slice(0,-6)); 
    });
    deflate_stream.end(message_data);
  } else {
    _frame_and_send(message_data);
  }
};

module.exports = Sender;

function writeUInt16BE(value, offset) {
  this[offset] = (value & 0xff00)>>8;
  this[offset+1] = value & 0xff;
}

function writeUInt32BE(value, offset) {
  this[offset] = (value & 0xff000000)>>24;
  this[offset+1] = (value & 0xff0000)>>16;
  this[offset+2] = (value & 0xff00)>>8;
  this[offset+3] = value & 0xff;
}

function getArrayBuffer(data) {
  // data is either an ArrayBuffer or ArrayBufferView.
  var array = new Uint8Array(data.buffer || data)
    , l = data.byteLength || data.length
    , o = data.byteOffset || 0
    , buffer = new Buffer(l);
  for (var i = 0; i < l; ++i) {
    buffer[i] = array[o+i];
  }
  return buffer;
}

function getRandomMask() {
  return new Buffer([
    ~~(Math.random() * 255),
    ~~(Math.random() * 255),
    ~~(Math.random() * 255),
    ~~(Math.random() * 255)
  ]);
}
