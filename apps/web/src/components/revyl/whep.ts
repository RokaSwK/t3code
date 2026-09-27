/**
 * Plays a WHEP stream (WebRTC-HTTP egress) into a video element. Revyl serves each device's
 * screen this way from Cloudflare, straight to the browser, so it never passes through the
 * T3 server and works the same from a remote client.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const ICE_GATHER_TIMEOUT_MS = 2_000;

export interface WhepPlayback {
  readonly close: () => void;
}

function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      connection.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (connection.iceGatheringState === "complete") done();
    };
    // Candidates gathered so far are enough; STUN answers arrive within a few hundred ms.
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    connection.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * Starts playback and resolves once the offer is answered. `onState` reports the connection
 * as it goes live, drops, or fails; call `close` to stop and release the session.
 */
export async function playWhep(input: {
  readonly url: string;
  readonly video: HTMLVideoElement;
  readonly onState: (state: RTCPeerConnectionState) => void;
}): Promise<WhepPlayback> {
  const connection = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
  let resource: string | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    connection.close();
    input.video.srcObject = null;
    if (resource) void fetch(resource, { method: "DELETE" }).catch(() => undefined);
  };
  try {
    connection.addTransceiver("video", { direction: "recvonly" });
    connection.addTransceiver("audio", { direction: "recvonly" });
    connection.addEventListener("track", (event) => {
      const [stream] = event.streams;
      input.video.srcObject = stream ?? new MediaStream([event.track]);
    });
    connection.addEventListener("connectionstatechange", () =>
      input.onState(connection.connectionState),
    );
    await connection.setLocalDescription(await connection.createOffer());
    await waitForIceGathering(connection);
    const response = await fetch(input.url, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: connection.localDescription?.sdp ?? "",
    });
    if (!response.ok) throw new Error(`The stream answered ${response.status}.`);
    const location = response.headers.get("location");
    resource = location ? new URL(location, input.url).toString() : null;
    const answer = await response.text();
    if (closed) return { close };
    await connection.setRemoteDescription({ type: "answer", sdp: answer });
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}
