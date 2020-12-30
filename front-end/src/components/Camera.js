import React, { useEffect, useRef } from 'react'
import WSAvcPlayer from "ws-avc-player";
import { Rnd } from 'react-rnd'
import { useState } from 'react';
import { Button, Switch, message } from 'antd';
import { useCreation, useEventListener } from '@umijs/hooks';
import store from "store";

import {
  BorderOutlined,
  UpSquareOutlined,
  RotateRightOutlined,
  FormOutlined,
  LockOutlined
} from "@ant-design/icons"

const defaultStatus = [
  {
    size: { width: window.innerWidth, height: window.innerWidth * 0.75 },
    position: { x: 0, y: 0, z: 1 }
  },
  {
    size: { width: window.innerWidth / 4, height: window.innerWidth * 0.75 / 4 },
    position: { x: window.innerWidth / 8 * 3, y: 0, z: 2 }
  },
  {
    size: { width: window.innerWidth / 4, height: window.innerWidth * 0.75 / 4 },
    position: { x: window.innerWidth / 8 * 3, y: 0, z: 2 }
  },
]


export default function Camera({
  url,
  index = 0,
}) {

  const storeName = `camera-${url}`;
  const boxEl = useRef(null);

  const [position, setPosition] = useState(defaultStatus[index].position); // 摄像头位置
  const [size, setViewSize] = useState(defaultStatus[index].size); // 画布大小
  const [rotate, setRotate] = useState(0);
  const [videoRate, setVideoRate] = useState(4/3); // 视频宽高比
  const [enabled, setEnabled] = useState(true);
  const [pause, setPause] = useState(false);
  const [editabled, setEditabled] = useState(false);
  const [cameraName ,setCameraName] = useState('')

  const wsavc = useCreation(() => {
    const { size: _size, position: _position } = store.get(storeName) || { size, position };
    setPosition(_position);
    setViewSize(_size);
    const w = new WSAvcPlayer({
      useWorker: true,
      workerFile: `${process.env.PUBLIC_URL}/Decoder.js`,
    });

    w.on('connected', function () {
      setEnabled(true);
      reCameraSize(size);
    })

    w.on("info", ({ cameraName, size: {width, height} }) => {
      setCameraName(cameraName);
      w.cameraName = cameraName
      setVideoRate(width/height)
    });

    w.on("resized", ({width, height}) => {
      message.success(`${w.cameraName} 开启 ${width}x${height}`)
      setVideoRate(width/height)
    })

    w.on("disconnected", function () {
      message.info(`${w.cameraName} 已断开`)
    });

    return w
  });



  function changeRotate() {
    if (rotate === 270) {
      setRotate(0);
    } else {
      setRotate(rotate + 90);
    }
  }


  function setFullScreen() {
    const width = window.innerWidth;
    const height = width / videoRate;
    setViewSize({ width, height });
    reCameraSize({ width, height });
    setPosition({ x: 0, y: (window.innerHeight - height) / 2, z: 0 });
  }

  function setCenterScreen() {
    const height = window.innerHeight / 4;
    const width = height * videoRate;
    const position = { x: (window.innerWidth - width) / 2, y: -38, z: 2 }
    setPosition(position)
    setViewSize({ width, height });
    reCameraSize({ width, height });
  }

  function start() {
    wsavc.connect(`${window.location.protocol === "https:" ? "wss://" : "ws://"}${url}`);
  }

  function end() {
    wsavc && wsavc.ws && wsavc.disconnect();
    wsavc.AvcPlayer.canvas.remove();
  }

  function reCameraSize(payload) {
    enabled && !pause && wsavc && wsavc.ws && wsavc.send("resize", payload)
  }

  useEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      setPause(false)
    }
    else {
      setPause(true)
    }
  }, { dom: document })

  useEffect(() => {
    const box = boxEl.current;
    if (!enabled || pause) {
      end()
    } else {
      start();
      box.appendChild(wsavc.AvcPlayer.canvas);
    }
    return function () {
      end()
    }
    // eslint-disable-next-line
  }, [url, wsavc, enabled, pause]);


  return (
    <Rnd
      disableDragging={!editabled}
      enableResizing={{ top: editabled, right: editabled, bottom: editabled, left: editabled, topRight: editabled, bottomRight: editabled, bottomLeft: editabled, topLeft: editabled }}
      className={editabled ? "camera-rnd" : "camera-rnd disabled"}
      lockAspectRatio={videoRate}
      tabIndex={1}
      size={size}
      position={position}
      onDragStop={(e, { x, y }) => {
        const p = { x, y, z: position.z };
        setPosition(p);
      }}
      onResizeStop={(e, direction, ref, delta, { x, y }) => {
        const p = { x, y, z: position.z };
        setPosition(p)
        const size = {
          width: ref.offsetWidth,
          height: ref.offsetHeight
        };
        setViewSize(size);
        reCameraSize(size);
      }}
      style={{ zIndex: position.z }}
    >
      {editabled ?
        <div className="button-box transition-animation" title={cameraName}>
          <Button size="small" shape="circle" icon={<BorderOutlined />} onClick={setFullScreen} />
          <Button size="small" shape="circle" icon={<UpSquareOutlined />} onClick={setCenterScreen} />
          <Button size="small" shape="circle" icon={<RotateRightOutlined />} onClick={changeRotate} />
          <Button size="small" shape="circle" icon={<LockOutlined />} onClick={() => {
            setEditabled(false)
            store.set(storeName, { size, position });
          }} />
        </div>
        : <div className="edit">
          <Button size="small" shape="circle" icon={<FormOutlined />} onClick={() => { setEditabled(true) }} />
          <br />
          {
            <Switch size="small" checked={enabled} onChange={setEnabled} />
          }
        </div>
      }
      <div className="camera-box" ref={boxEl}
        style={{
          transform: `rotate(${rotate}deg)`
        }}
      >
      </div>
    </Rnd>
  )
}
