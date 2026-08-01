package com.retro.radio;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.security.cert.X509Certificate;

public class IcyCleanProxy {
    private static final String TAG = "RetroRadioIcy";
    private static final int SOCKET_TIMEOUT_MS = 15000;
    private static final int HEADER_READ_LIMIT = 64 * 1024;

    public interface Listener {
        void onStarted(int port);
        void onError(String reason);
    }

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicInteger seq = new AtomicInteger(0);
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private ExecutorService workers;
    private Listener listener;
    private int port = 0;

    public synchronized void start(Listener l) {
        if (running.get()) { if (l != null) l.onStarted(port); return; }
        this.listener = l;
        workers = Executors.newCachedThreadPool();
        try {
            serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            serverSocket.setReuseAddress(true);
            port = serverSocket.getLocalPort();
            running.set(true);
            acceptThread = new Thread(this::acceptLoop, "IcyProxyAccept");
            acceptThread.setDaemon(true);
            acceptThread.start();
            Log.i(TAG, "IcyCleanProxy started on http://127.0.0.1:" + port);
            if (l != null) l.onStarted(port);
        } catch (Throwable t) {
            Log.e(TAG, "start FAIL: " + t, t);
            if (l != null) l.onError(t.toString());
        }
    }

    public synchronized void stop() {
        if (!running.compareAndSet(true, false)) return;
        try { if (serverSocket != null && !serverSocket.isClosed()) serverSocket.close(); } catch (Throwable ignore) {}
        try { if (workers != null) workers.shutdownNow(); } catch (Throwable ignore) {}
        acceptThread = null;
        workers = null;
        serverSocket = null;
        port = 0;
    }

    public int getPort() { return port; }

    public String wrap(String url) {
        if (url == null) return null;
        if (port <= 0) return url;
        try {
            String enc = java.net.URLEncoder.encode(url, "UTF-8");
            return "http://127.0.0.1:" + port + "/p?u=" + enc + "&r=" + seq.incrementAndGet();
        } catch (Throwable t) { return url; }
    }

    private void acceptLoop() {
        while (running.get()) {
            try {
                Socket client = serverSocket.accept();
                workers.submit(() -> handleClient(client));
            } catch (SocketTimeoutException st) {
                // keep looping
            } catch (Throwable t) {
                if (!running.get()) break;
                Log.w(TAG, "acceptLoop err: " + t);
                try { Thread.sleep(50); } catch (InterruptedException ie) { break; }
            }
        }
    }

    private static final TrustManager[] TRUST_ALL = new TrustManager[]{
        new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] c, String a) {}
            public void checkServerTrusted(X509Certificate[] c, String a) {}
        }
    };

    private void handleClient(Socket client) {
        InputStream clientIn = null; OutputStream clientOut = null;
        Socket remote = null; InputStream remoteIn = null; OutputStream remoteOut = null;
        try {
            client.setSoTimeout(SOCKET_TIMEOUT_MS);
            clientIn = client.getInputStream();
            clientOut = client.getOutputStream();

            String reqLine = readLine(clientIn);
            if (reqLine == null) { badRequest(clientOut, "empty request"); return; }

            Map<String, String> headers = new HashMap<>();
            String h;
            while ((h = readLine(clientIn)) != null && h.length() > 0) {
                int c = h.indexOf(':');
                if (c > 0) headers.put(h.substring(0, c).trim().toLowerCase(Locale.ROOT), h.substring(c+1).trim());
            }

            String[] parts = reqLine.split(" ");
            if (parts.length < 2) { badRequest(clientOut, "bad req: " + reqLine); return; }
            String path = parts[1];
            int q = path.indexOf('?');
            String query = q >= 0 ? path.substring(q+1) : "";
            Map<String, String> qp = parseQuery(query);
            String target = qp.get("u");
            if (target == null || target.isEmpty()) {
                badRequest(clientOut, "missing ?u="); return;
            }
            target = java.net.URLDecoder.decode(target, "UTF-8");

            URI uri = new URI(target);
            boolean isTls = "https".equalsIgnoreCase(uri.getScheme());
            String host = uri.getHost();
            int uriPort = uri.getPort();
            int rPort = uriPort > 0 ? uriPort : (isTls ? 443 : 80);

            String pathAndQuery;
            if (uri.getRawQuery() != null) pathAndQuery = (uri.getRawPath() == null ? "/" : uri.getRawPath()) + "?" + uri.getRawQuery();
            else pathAndQuery = (uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath());

            // Connect remote
            if (isTls) {
                try {
                    SSLContext ctx = SSLContext.getInstance("TLS");
                    ctx.init(null, TRUST_ALL, new java.security.SecureRandom());
                    remote = ctx.getSocketFactory().createSocket(host, rPort);
                } catch (Throwable tls) {
                    remote = new Socket(host, rPort);
                }
            } else {
                remote = new Socket(host, rPort);
            }
            remote.setSoTimeout(SOCKET_TIMEOUT_MS);
            remoteIn = remote.getInputStream();
            remoteOut = remote.getOutputStream();

            // Forward request but add Icy-Metadata: 0 if not present, otherwise respect original
            StringBuilder req = new StringBuilder();
            req.append("GET ").append(pathAndQuery).append(" HTTP/1.0\r\n");
            req.append("Host: ").append(host);
            if (uriPort > 0 && !(isTls && uriPort==443) && !(!isTls && uriPort==80)) req.append(':').append(uriPort);
            req.append("\r\n");
            boolean icyMetaSeen = false;
            boolean userAgentSeen = false;
            boolean acceptSeen = false;
            for (Map.Entry<String,String> e : headers.entrySet()) {
                String k = e.getKey();
                String v = e.getValue();
                if ("host".equals(k) || "accept-encoding".equals(k) || "connection".equals(k) || "proxy-connection".equals(k)) continue;
                if ("icy-metadata".equals(k)) { icyMetaSeen = true; v = "1"; } // we want metaint header but we'll strip
                if ("user-agent".equals(k)) userAgentSeen = true;
                if ("accept".equals(k)) acceptSeen = true;
                req.append(capitalize(k)).append(": ").append(v).append("\r\n");
            }
            if (!icyMetaSeen) req.append("Icy-Metadata: 1\r\n");
            if (!userAgentSeen) req.append("User-Agent: WinampMPEG/5.0\r\n");
            if (!acceptSeen) req.append("Accept: */*\r\n");
            req.append("Connection: close\r\n\r\n");
            remoteOut.write(req.toString().getBytes(StandardCharsets.ISO_8859_1));
            remoteOut.flush();

            // Read remote response status line
            String statusLine = readLine(remoteIn);
            if (statusLine == null) { badRequest(clientOut, "empty remote response"); return; }
            boolean isIcyStatus = statusLine.regionMatches(true, 0, "ICY ", 0, 4);

            int statusCode = 200;
            String statusText = "OK";
            if (isIcyStatus) {
                String rest = statusLine.substring(4).trim();
                int sp = rest.indexOf(' ');
                try { statusCode = Integer.parseInt(sp >= 0 ? rest.substring(0, sp) : rest); } catch (Throwable ignore) {}
                statusText = sp >= 0 ? rest.substring(sp + 1).trim() : "ICY OK";
            } else {
                String[] s = statusLine.split(" ", 3);
                if (s.length >= 2) try { statusCode = Integer.parseInt(s[1]); } catch (Throwable ignore) {}
                if (s.length >= 3) statusText = s[2];
            }

            if (statusCode < 200 || statusCode >= 400) {
                badRequest(clientOut, "remote status " + statusCode + " " + statusText + "\r\nFor " + target);
                return;
            }

            Map<String, String> respHeaders = new HashMap<>();
            String rh;
            while ((rh = readLine(remoteIn)) != null && rh.length() > 0) {
                int c = rh.indexOf(':');
                if (c > 0) respHeaders.put(rh.substring(0, c).trim().toLowerCase(Locale.ROOT), rh.substring(c+1).trim());
            }

            int metaInt = 0;
            String mi = respHeaders.get("icy-metaint");
            if (mi != null && !mi.isEmpty()) {
                try { metaInt = Integer.parseInt(mi); } catch (Throwable ignore) { metaInt = 0; }
            }

            // Build cleaned response for client
            StringBuilder resp = new StringBuilder();
            resp.append("HTTP/1.1 ").append(statusCode).append(' ').append(sanitizeStatus(statusText)).append("\r\n");
            resp.append("Content-Type: ").append(detectContentType(respHeaders, target)).append("\r\n");
            resp.append("Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n");
            resp.append("Pragma: no-cache\r\n");
            resp.append("Expires: 0\r\n");
            resp.append("Access-Control-Allow-Origin: *\r\n");
            resp.append("Access-Control-Expose-Headers: *\r\n");
            resp.append("Connection: close\r\n");
            String cl = respHeaders.get("content-length");
            if (cl != null && metaInt <= 0) resp.append("Content-Length: ").append(cl).append("\r\n");
            else resp.append("Transfer-Encoding: chunked\r\n");
            resp.append("\r\n");
            clientOut.write(resp.toString().getBytes(StandardCharsets.ISO_8859_1));
            clientOut.flush();

            // Pipe audio bytes, stripping ICY metadata interleaving, and chunk if needed
            boolean chunked = (cl == null || metaInt > 0);
            streamClean(remoteIn, clientOut, metaInt, chunked);
        } catch (Throwable t) {
            Log.w(TAG, "handleClient FAIL: " + t);
        } finally {
            try { if (clientIn != null) clientIn.close(); } catch (Throwable ignore) {}
            try { if (clientOut != null) clientOut.close(); } catch (Throwable ignore) {}
            try { if (client != null) client.close(); } catch (Throwable ignore) {}
            try { if (remoteOut != null) remoteOut.close(); } catch (Throwable ignore) {}
            try { if (remoteIn != null) remoteIn.close(); } catch (Throwable ignore) {}
            try { if (remote != null) remote.close(); } catch (Throwable ignore) {}
        }
    }

    private static String sanitizeStatus(String s) {
        StringBuilder r = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c == 0x7f) continue;
            r.append(c);
        }
        String out = r.toString().trim();
        return out.isEmpty() ? "OK" : out;
    }

    private static String detectContentType(Map<String,String> h, String url) {
        String ct = h.get("content-type");
        if (ct != null && !ct.isEmpty()) {
            int sc = ct.indexOf(';');
            if (sc > 0) ct = ct.substring(0, sc).trim();
            if (ct.toLowerCase(Locale.ROOT).startsWith("audio/") || ct.toLowerCase(Locale.ROOT).startsWith("video/") || ct.equalsIgnoreCase("application/octet-stream")) return ct;
        }
        String u = url.toLowerCase(Locale.ROOT);
        if (u.contains(".m3u8")) return "application/vnd.apple.mpegurl";
        if (u.contains(".aac")) return "audio/aac";
        if (u.contains(".mp3")) return "audio/mpeg";
        return "audio/mpeg";
    }

    private static void streamClean(InputStream in, OutputStream out, int metaInt, boolean chunked) throws IOException {
        if (metaInt <= 0) {
            pipeChunked(in, out, chunked);
            return;
        }
        byte[] buf = new byte[64 * 1024];
        long sent = 0;
        int remainingAudio = metaInt;
        while (true) {
            int want = Math.min(buf.length, remainingAudio);
            int n = in.read(buf, 0, want);
            if (n < 0) break;
            if (n > 0) {
                if (chunked) writeChunk(out, buf, 0, n);
                else out.write(buf, 0, n);
                sent += n;
            }
            remainingAudio -= n;
            if (remainingAudio == 0) {
                int mL = in.read();
                if (mL < 0) break;
                int toSkip = mL * 16;
                while (toSkip > 0) {
                    long s = in.skip(toSkip);
                    if (s <= 0) { int r = in.read(); if (r < 0) break; toSkip--; }
                    else toSkip -= s;
                }
                remainingAudio = metaInt;
            }
        }
        if (chunked) out.write("0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private static void pipeChunked(InputStream in, OutputStream out, boolean chunked) throws IOException {
        byte[] buf = new byte[64 * 1024];
        while (true) {
            int n = in.read(buf);
            if (n < 0) break;
            if (n == 0) continue;
            if (chunked) writeChunk(out, buf, 0, n);
            else out.write(buf, 0, n);
        }
        if (chunked) out.write("0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private static void writeChunk(OutputStream out, byte[] buf, int off, int len) throws IOException {
        String head = Integer.toHexString(len) + "\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(buf, off, len);
        out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private static Map<String,String> parseQuery(String q) {
        Map<String,String> r = new HashMap<>();
        if (q == null) return r;
        for (String p : q.split("&")) {
            int e = p.indexOf('=');
            try {
                if (e < 0) r.put(java.net.URLDecoder.decode(p, "UTF-8"), "");
                else r.put(java.net.URLDecoder.decode(p.substring(0, e), "UTF-8"), java.net.URLDecoder.decode(p.substring(e+1), "UTF-8"));
            } catch (Throwable ignore) {}
        }
        return r;
    }

    private static String capitalize(String s) {
        if (s == null || s.isEmpty()) return s;
        char[] c = s.toCharArray();
        boolean up = true;
        for (int i = 0; i < c.length; i++) {
            if (up && c[i] >= 'a' && c[i] <= 'z') c[i] = (char)(c[i] - 32);
            up = (c[i] == '-');
        }
        return new String(c);
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        int b;
        int count = 0;
        while ((b = in.read()) >= 0) {
            if (b == '\n') break;
            if (b != '\r') bo.write(b);
            count++;
            if (count > HEADER_READ_LIMIT) throw new IOException("header too long");
        }
        if (count == 0 && b < 0) return null;
        return bo.toString("ISO-8859-1");
    }

    private static void badRequest(OutputStream out, String msg) {
        try {
            String r = "HTTP/1.1 400 Bad Request\r\n" +
                    "Content-Type: text/plain; charset=utf-8\r\n" +
                    "Cache-Control: no-store\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Connection: close\r\n" +
                    "Content-Length: " + msg.getBytes(StandardCharsets.UTF_8).length + "\r\n\r\n" + msg;
            out.write(r.getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (Throwable ignore) {}
    }
}
