import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

/** 重连关闭旧 peer 时，采集源仍属于新 peer，不能随旧 sender 一起停止。 */
export class MeetingTransport extends SmallWebRTCTransport {
  // shortcut: pc / closePeerConnection 是 SDK 1.10.8 未声明的内部接口，升级时须复核关闭顺序。
  closePeerConnection(peer: RTCPeerConnection): void {
    const current = (this as unknown as { pc: RTCPeerConnection | null }).pc;
    const source = this.tracks().local.audio;
    const sharedAudio =
      peer !== current && source && current?.getSenders().some((sender) => sender.track === source)
        ? source
        : null;
    peer.getTransceivers().forEach((transceiver) => {
      if (transceiver.stop) transceiver.stop();
    });
    peer.getSenders().forEach((sender) => {
      if (sender.track !== sharedAudio) sender.track?.stop();
    });
    peer.close();
  }
}
