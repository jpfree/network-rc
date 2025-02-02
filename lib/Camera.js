const spawn = require("child_process").spawn;
const Splitter = require("stream-split");
const NALseparator = Buffer.from([0, 0, 0, 1]);
const { WebSocketServer } = require("@clusterws/cws");
const status = require("./status");
const { asyncCommand } = require("./unit");

exports.NALseparator = NALseparator;

module.exports = class Camera {
  constructor(options) {
    this.options = options;
    const {
      cameraIndex,
      cardType,
      name,
      deviceSize,
      server,
      devPath,
    } = options;

    getCameraFormats(devPath).then((v) => {
      this.formatList = v.filter(({ format }) =>
        ["yuyv422", "mjpeg", "h264"].includes(format)
      );
      console.log(`${name}格式列表`, this.formatList);
    });

    if (deviceSize.width - 0 > 640) {
      deviceSize.height = ((deviceSize.height - 0) / deviceSize.width) * 640;
      deviceSize.width = 640;
    }

    this.cameraName = `${name}(${cardType})`;
    this.maxSizeWidth =
      deviceSize.width > status.config.cameraMaxWidth
        ? status.config.cameraMaxWidth
        : deviceSize.width;
    const path = `/video${cameraIndex}`;
    this.clients = new Set();
    console.log(`Camera ${this.cameraName} websocker server starting`, path);
    const wss = new WebSocketServer(
      {
        noServer: true,
        path,
      },
      () => {
        console.log(`Camera ${this.cameraName} websocker server started`, path);
      }
    );

    server.on("upgrade", (request, socket, head) => {
      if (request.url === path)
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
    });

    this.wss = wss;

    wss.on("connection", async (socket) => {
      console.log(`客户端已连接 Camera ${this.cameraName}`);
      const config = status.config[devPath] || {};
      socket.send(
        JSON.stringify({
          action: "info",
          payload: {
            size: this.options.deviceSize,
            cameraName: this.cameraName,
            formatList: this.formatList || [],
            ...config,
          },
        })
      );

      socket.on("message", (m) => {
        const { action, payload } = JSON.parse(m);
        console.log(`Camera ${this.cameraName} 收到 message`, m);
        switch (action) {
          case "open-request":
            let { width, inputFormatIndex, fps = 30 } = {
              ...config,
              ...payload,
            };
            if (inputFormatIndex === undefined) {
              const index = this.formatList.findIndex(
                ({ format }) => format === "mjpeg"
              );
              inputFormatIndex = index < 0 ? 0 : index;
            }
            this.open({ width, inputFormatIndex, fps, socket });
            break;
          default:
        }
      });

      socket.on("close", () => {
        if (wss.clients.length === 0) {
          this.close();
        }
      });
    });

    wss.on("error", (err) => {
      console.error(err);
    });
  }

  async open({ width = 400, inputFormatIndex, fps }) {
    console.log("inputFormatIndex", inputFormatIndex);
    console.log("fps", fps);
    const { deviceSize, devPath } = this.options;
    width = Math.floor(width);
    if (width > this.maxSizeWidth) {
      width = this.maxSizeWidth;
    }

    let height = (width / deviceSize.width) * deviceSize.height;

    /** 编码器要求分辨率为 x 的倍数 */
    const x = 32;
    width = Math.ceil(width / x) * x;
    height = Math.ceil(height / x) * x;

    if (this.streamer) {
      console.log(`Camera ${this.cameraName} ffmpeg streamer already open`);
      this.close();
    }

    console.log(`Camera ${this.cameraName} , 输出分辨率:${width}x${height}`);

    this.currentSize = { width, height };

    this.broadcast("open", { inputFormatIndex, fps });
    status.saveConfig({ [devPath]: { inputFormatIndex, fps } });
    this.broadcast("initalize", {
      size: { width, height },
      cameraName: this.cameraName,
    });
    this.broadcast("stream_active", true);

    this.streamer = ffmpeg(
      { width, height },
      this.options.devPath,
      this.formatList[inputFormatIndex],
      fps
    );
    const readStream = this.streamer.stdout.pipe(new Splitter(NALseparator));
    readStream.on("data", (frame) => {
      this.broadcastStream(Buffer.concat([NALseparator, frame]));
    });
    readStream.on("end", () => {
      this.broadcast("stream_active", false);
    });
  }

  close() {
    if (this.streamer) {
      console.log(`Camera ${this.cameraName} ffmpeg streamer killing`);
      this.streamer.kill("SIGHUP");
      this.streamer = undefined;
      this.currentSize = undefined;
    }
  }

  sendBinary(socket, frame) {
    if (socket.buzy) return;
    socket.buzy = true;
    socket.buzy = false;

    socket.send(frame, { binary: true }, function ack() {
      socket.buzy = false;
    });
  }

  broadcast(action, payload) {
    this.wss.clients.forEach((socket) =>
      socket.send(JSON.stringify({ action, payload }))
    );
  }

  broadcastStream(data) {
    this.wss.clients.forEach((socket) => {
      this.sendBinary(socket, data);
    });
  }
};

module.exports.getCameraList = async function () {
  try {
    const devList = [];
    return new Promise((resolve) => {
      const v4l = spawn("v4l2-ctl", ["--list-devices"]);
      v4l.stdout.on("data", (data) => {
        data
          .toString()
          .split("\n")
          .forEach((line) => {
            if (/\/dev\/video[0-9]$/.test(line)) {
              devList.push({ dev: line.trim() });
            }
          });
      });
      v4l.on("exit", async () => {
        for (let index = 0; index < devList.length; index++) {
          const item = devList[index];
          let outText = await asyncCommand(
            `v4l2-ctl --device=${item.dev} --all`
          );
          const name = /Driver name\s*\:\s*([^.]+)$/gims.exec(outText)[1];
          const cardType = /Card type\s*\:\s*([^.]+)/gims.exec(outText)[1];
          outText = await asyncCommand(
            `v4l2-ctl --device=${item.dev} --list-formats-ext`
          );
          const sizeR = /(\d+x\d+)/g;
          let size;
          let match;
          while ((match = sizeR.exec(outText)) !== null) {
            let [width, height] = match[0].split("x");
            width = width - 0;
            height = height - 0;
            if (size) {
              if (size.width < width) {
                size = { width, height };
              }
            } else {
              size = { width, height };
            }
          }
          item.name = name;
          item.cardType = cardType;
          item.size = size;
        }

        console.log("摄像头列表:");
        devList.forEach(({ name, cardType, dev, size }) => {
          if (size) {
            console.log(
              `  ${name}(${cardType})  最大分辨率: ${size.width}x${size.height}`
            );
          } else {
            console.log(`  ${name}(${cardType})  无法获取分辨率，已过滤`);
          }
        });
        resolve(devList.filter((i) => i.size));
      });
    });
  } catch (e) {
    console.error(e);
  }
};

const getCameraFormats = async function (devPath) {
  const result = await asyncCommand(
    `ffmpeg -f v4l2 -list_formats all -i ${devPath}`,
    "stderr"
  );
  const regexp = /\[video4linux2,v4l2 \@ ([\s\S]+?)\] ([\S]+) *?\:\s*([\S]+) \: +[\s\S]+?: ([\s\S]+?)\n/g;
  const list = [];
  while ((match = regexp.exec(result)) != null) {
    const [string, id, compressed, format, size = ""] = match;
    (size.match(/\d+x\d+/g) || ["640x480"]).forEach((size) => {
      list.push({ id, format, size });
    });
  }
  return list;
};

const ffmpeg = function (outSize, input, inputformat, fps = 30) {
  console.log(`${input} input format`, inputformat);
  console.log(`${input} input fps`, fps);
  const streamer = spawn("ffmpeg", [
    "-f",
    "video4linux2",
    "-input_format",
    inputformat.format,
    "-s",
    inputformat.size,
    "-r",
    fps,
    "-i",
    input,
    "-c:v",
    "h264_omx",
    "-b:v",
    "1000k",
    "-profile:v",
    "baseline",
    "-f",
    "rawvideo",
    "-s",
    `${outSize.width}x${outSize.height}`,
    "-r",
    fps,
    "-",
  ]);

  streamer.on("close", (e) => {
    console.log("Streamer ffmpeg streamer close", e);
  });

  streamer.stderr.on("data", (data) => {
    // console.log(`Streame ffmpeg stderr ${input}`, data.toString());
  });

  // streamer.stdout.on("data", (data) => {
  //   console.log(`Streame ffmpeg stdout ${input}`, data.toString());
  // });

  return streamer;
};
