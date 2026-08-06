package com.local.codexbridge;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Environment;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;
import android.provider.Settings;
import android.provider.MediaStore;
import android.telephony.TelephonyManager;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import org.json.JSONObject;
import org.json.JSONArray;

import java.util.List;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final String PREFS = "codex_bridge";
    private static final String KEY_MODE = "mode";
    private static final String KEY_URL = "server_url";
    private static final String KEY_ROOM = "room_code";
    private static final String KEY_PASSWORD = "relay_password";
    private static final String KEY_UPDATE_URL = "update_url";
    private static final String KEY_EFFORT = "effort";
    private static final String KEY_AUTO_SPEAK = "auto_speak";
    private static final String KEY_CAP_DEVICE_STATUS = "cap_device_status";
    private static final String KEY_CAP_IMAGE_GEN = "cap_image_gen";
    private static final String KEY_BROKER = "broker";
    private static final String RELAY_BROKER = "wss://broker.emqx.io:8084/mqtt";
    private static final String APP_VERSION = "10.45";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private ValueCallback<Uri[]> fileChooserCallback;
    private String pendingKey = "";

    private WebView web;
    private View lanErrorOverlay;
    private boolean lanWebLoading = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable lanLoadTimeout;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pruneDownloadsCache(); // 清理历史残留的下载缓存（最多 10 个）
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 2002);
        }
        startKeepAlive();
        if (android.os.Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(Color.parseColor("#0b0e14"));
            getWindow().setNavigationBarColor(Color.parseColor("#0b0e14"));
        }
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String mode = prefs.getString(KEY_MODE, "");
        if (mode.isEmpty()) {
            showSetupScreen();
        } else {
            setupUi();
        }
    }

    // 下载缓存上限：filesDir/downloads 最多保留 10 个，超出删最旧
    private void pruneDownloadsCache() {
        try {
            File dir = new File(getFilesDir(), "downloads");
            if (!dir.exists()) return;
            File[] files = dir.listFiles();
            if (files == null || files.length <= 10) return;
            java.util.Arrays.sort(files, new java.util.Comparator<java.io.File>() {
                @Override public int compare(java.io.File a, java.io.File b) {
                    return Long.compare(a.lastModified(), b.lastModified());
                }
            });
            for (int i = 0; i < files.length - 10; i++) files[i].delete();
        } catch (Exception e) {}
    }

    private void startKeepAlive() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(new Intent(this, KeepAliveService.class));
            } else {
                startService(new Intent(this, KeepAliveService.class));
            }
        } catch (Exception ignored) {}
    }

    private class JsBridge {
        @JavascriptInterface
        public String getRelayConfig() {
            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (!"relay".equals(p.getString(KEY_MODE, ""))) return "";
            try {
                JSONObject o = new JSONObject();
                o.put("broker", RELAY_BROKER);
                o.put("roomCode", p.getString(KEY_ROOM, ""));
                o.put("password", p.getString(KEY_PASSWORD, ""));
                o.put("effort", p.getString(KEY_EFFORT, "medium"));
                o.put("autoSpeak", p.getBoolean(KEY_AUTO_SPEAK, true));
                o.put("broker", p.getString(KEY_BROKER, RELAY_BROKER));
                return o.toString();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String getEffort() {
            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            return p.getString(KEY_EFFORT, "medium");
        }

        @JavascriptInterface
        public boolean getAutoSpeak() {
            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            return p.getBoolean(KEY_AUTO_SPEAK, true);
        }

        // 能力探测：列出手机支持的所有命令与开关状态（新能力默认关闭）
        @JavascriptInterface
        public String getCapabilities() {
            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONObject o = new JSONObject();
            try {
                o.put("list_apps", true);
                o.put("uninstall_app", true);
                o.put("open_app", true);
                o.put("open_app_background", true);
                o.put("go_home", true);
                o.put("app_settings", true);
                o.put("ignore_battery", true);
                o.put("device_status", p.getBoolean(KEY_CAP_DEVICE_STATUS, false));
                o.put("image_generation", p.getBoolean(KEY_CAP_IMAGE_GEN, false));
            } catch (Exception ignored) {}
            return o.toString();
        }

        // 设备状态查询（设置里默认关闭）
        @JavascriptInterface
        public String getDeviceStatus() {
            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (!p.getBoolean(KEY_CAP_DEVICE_STATUS, false)) {
                return "{\"ok\":false,\"error\":\"设备状态查询未开启，请在设置里开启后重试\"}";
            }
            JSONObject o = new JSONObject();
            try {
                o.put("ok", true);
                JSONObject d = new JSONObject();
                d.put("manufacturer", Build.MANUFACTURER);
                d.put("model", Build.MODEL);
                d.put("androidVersion", Build.VERSION.RELEASE);
                d.put("sdkInt", Build.VERSION.SDK_INT);
                IntentFilter bf = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
                Intent b = registerReceiver(null, bf);
                if (b != null) {
                    int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                    int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                    int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                    d.put("batteryPercent", scale > 0 ? Math.round(level * 100f / scale) : -1);
                    d.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL);
                } else {
                    d.put("batteryPercent", -1);
                    d.put("charging", false);
                }
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                String netType = "unknown";
                if (cm != null) {
                    Network n = cm.getActiveNetwork();
                    NetworkCapabilities nc = n != null ? cm.getNetworkCapabilities(n) : null;
                    if (nc != null) {
                        if (nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                            netType = "wifi";
                        } else if (nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                            netType = "mobile";
                            try {
                                TelephonyManager tm = (TelephonyManager) getSystemService(Context.TELEPHONY_SERVICE);
                                int nt = tm != null ? tm.getDataNetworkType() : TelephonyManager.NETWORK_TYPE_UNKNOWN;
                                if (nt == TelephonyManager.NETWORK_TYPE_NR) netType = "5g";
                                else if (nt >= TelephonyManager.NETWORK_TYPE_LTE) netType = "4g";
                                else if (nt >= TelephonyManager.NETWORK_TYPE_HSPA) netType = "3g";
                            } catch (Exception ignored) {}
                        }
                    }
                }
                d.put("networkType", netType);
                DisplayMetrics dm = getResources().getDisplayMetrics();
                d.put("screenWidth", dm.widthPixels);
                d.put("screenHeight", dm.heightPixels);
                StatFs sf = new StatFs(Environment.getDataDirectory().getAbsolutePath());
                long total = sf.getTotalBytes();
                long avail = sf.getAvailableBytes();
                d.put("storageTotalGB", Math.round(total / 1073741824.0 * 10) / 10.0);
                d.put("storageFreeGB", Math.round(avail / 1073741824.0 * 10) / 10.0);
                o.put("data", d);
            } catch (Exception e) {
                try { o.put("ok", false); o.put("error", "读取设备状态失败: " + e.getMessage()); } catch (Exception ignored) {}
            }
            return o.toString();
        }

        // 保存图片到系统相册：支持 http(s) 绝对地址（局域网）和 data:image base64（中继）
        @JavascriptInterface
        public String saveImageToGallery(String url) {
            try {
                if (url == null || url.isEmpty()) return "空地址";
                if (Build.VERSION.SDK_INT < 29) {
                    if (checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE") != PackageManager.PERMISSION_GRANTED) {
                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                requestPermissions(new String[]{"android.permission.WRITE_EXTERNAL_STORAGE"}, 2003);
                            }
                        });
                        return "需要存储权限，请在系统弹窗允许后重试";
                    }
                }
                final byte[] data;
                final String ext;
                if (url.startsWith("file://")) {
                    data = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(url.substring("file://".length())));
                    ext = url.endsWith(".jpg") ? ".jpg" : ".png";
                } else if (url.startsWith("data:image")) {
                    String b64 = url.substring(url.indexOf(',') + 1);
                    data = Base64.decode(b64, Base64.DEFAULT);
                    ext = url.startsWith("data:image/jpeg") ? ".jpg" : ".png";
                } else {
                    java.net.URL u = new java.net.URL(url);
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(30000);
                    c.setRequestProperty("User-Agent", "codex-phone-bridge");
                    android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                    String cookie = cm.getCookie(url);
                    if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                    java.io.InputStream in = c.getInputStream();
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                    in.close();
                    data = bos.toByteArray();
                    String ct = c.getContentType();
                    ext = (ct != null && ct.contains("jpeg")) ? ".jpg" : ".png";
                    c.disconnect();
                }
                String name = "qidian_" + System.currentTimeMillis() + ext;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                    cv.put(MediaStore.Images.Media.MIME_TYPE, ext.equals(".jpg") ? "image/jpeg" : "image/png");
                    cv.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/鳍点AI");
                    android.net.Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return "保存失败：无法创建相册条目";
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(data);
                    os.close();
                } else {
                    String saved = MediaStore.Images.Media.insertImage(getContentResolver(),
                            BitmapFactory.decodeByteArray(data, 0, data.length), name, "鳍点AI 生成的图片");
                    if (saved == null) return "保存失败：相册写入失败";
                }
                return "ok";
            } catch (Exception e) {
                return "保存失败: " + (e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }

        // 生成图缓存到 App 私有目录（最多 10 张，超出删最旧），返回本地路径
        @JavascriptInterface
        public String cacheImageToApp(String url) {
            try {
                if (url == null || url.isEmpty()) return "";
                byte[] data;
                String ext = ".png";
                if (url.startsWith("data:image")) {
                    String b64 = url.substring(url.indexOf(',') + 1);
                    data = Base64.decode(b64, Base64.DEFAULT);
                    if (url.startsWith("data:image/jpeg")) ext = ".jpg";
                } else if (url.startsWith("file://")) {
                    String path = url.substring("file://".length());
                    if (!path.startsWith(getFilesDir().getAbsolutePath())) return "";
                    data = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(path));
                } else {
                    java.net.URL u = new java.net.URL(url);
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(30000);
                    c.setRequestProperty("User-Agent", "codex-phone-bridge");
                    android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                    String cookie = cm.getCookie(url);
                    if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                    java.io.InputStream in = c.getInputStream();
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                    in.close();
                    data = bos.toByteArray();
                    String ct = c.getContentType();
                    if (ct != null && ct.contains("jpeg")) ext = ".jpg";
                    c.disconnect();
                }
                File dir = new File(getFilesDir(), "images");
                if (!dir.exists()) dir.mkdirs();
                String name = "img_" + System.currentTimeMillis() + ext;
                File f = new File(dir, name);
                java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
                fos.write(data);
                fos.close();
                // 缓存上限 10 张，超出删最旧
                File[] files = dir.listFiles();
                if (files != null && files.length > 10) {
                    java.util.Arrays.sort(files, new java.util.Comparator<java.io.File>() {
                        @Override public int compare(java.io.File a, java.io.File b) {
                            return Long.compare(a.lastModified(), b.lastModified());
                        }
                    });
                    for (int i = 0; i < files.length - 10; i++) files[i].delete();
                }
                return f.getAbsolutePath();
            } catch (Exception e) {
                return "";
            }
        }

        // 下载 AI 生成/修改的文件：存到系统公共 Downloads（App 私有目录留缓存副本），Toast 显示完整路径
        @JavascriptInterface
        public String saveFileToPhone(String url, String filename) {
            try {
                if (url == null || url.isEmpty()) return "空地址";
                if (Build.VERSION.SDK_INT < 29) {
                    if (checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE") != PackageManager.PERMISSION_GRANTED) {
                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                requestPermissions(new String[]{"android.permission.WRITE_EXTERNAL_STORAGE"}, 2004);
                            }
                        });
                        return "需要存储权限，请在系统弹窗允许后重试";
                    }
                }
                byte[] data;
                if (url.startsWith("data:")) {
                    String b64 = url.substring(url.indexOf(',') + 1);
                    data = Base64.decode(b64, Base64.DEFAULT);
                } else {
                    java.net.URL u = new java.net.URL(url);
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(60000);
                    c.setRequestProperty("User-Agent", "codex-phone-bridge");
                    android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                    String cookie = cm.getCookie(url);
                    if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                    int code = c.getResponseCode();
                    if (code != 200) {
                        c.disconnect();
                        return "HTTP " + code + (code == 401 ? " 未授权（请重新登录电脑端）" : " 下载失败");
                    }
                    java.io.InputStream in = c.getInputStream();
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    long total = 0;
                    while ((n = in.read(buf)) > 0) {
                        bos.write(buf, 0, n);
                        total += n;
                        if (total > 20L * 1024 * 1024) {
                            in.close();
                            c.disconnect();
                            return "文件过大（超过 20MB）";
                        }
                    }
                    in.close();
                    data = bos.toByteArray();
                    c.disconnect();
                }
                if (data.length == 0) return "文件内容为空";
                String safe = (filename == null ? "" : filename).replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
                if (safe.isEmpty()) safe = "download_" + System.currentTimeMillis();
                if (!safe.contains(".")) safe = safe + ".bin";
                File dir = new File(getFilesDir(), "downloads");
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, safe);
                java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
                fos.write(data);
                fos.close();
                pruneDownloadsCache(); // 超出 10 个删最旧
                String publicPath;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mimeFor(safe));
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    android.net.Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return "保存到公共下载目录失败：无法创建条目";
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) return "保存到公共下载目录失败：无法打开条目";
                    os.write(data);
                    os.close();
                    String real = null;
                    android.database.Cursor cur = getContentResolver().query(uri, new String[]{MediaStore.MediaColumns.DATA}, null, null, null);
                    if (cur != null) {
                        if (cur.moveToFirst()) real = cur.getString(0);
                        cur.close();
                    }
                    publicPath = real != null ? real : new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), safe).getAbsolutePath();
                } else {
                    File pubDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!pubDir.exists()) pubDir.mkdirs();
                    File pf = new File(pubDir, safe);
                    java.io.FileOutputStream pfos = new java.io.FileOutputStream(pf);
                    pfos.write(data);
                    pfos.close();
                    publicPath = pf.getAbsolutePath();
                }
                final String shown = publicPath;
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        Toast.makeText(MainActivity.this, "已下载到手机：" + shown, Toast.LENGTH_LONG).show();
                    }
                });
                return "ok";
            } catch (Exception e) {
                return e.getMessage() == null ? e.toString() : e.getMessage();
            }
        }

        // 打开已下载的 AI 文件：优先本地缓存，缺失则先下载再打开；通过 LocalFileProvider 交给系统选择应用
        @JavascriptInterface
        public String openFile(String url, String filename) {
            try {
                if (filename == null || filename.isEmpty()) return "空文件名";
                String safe = filename.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
                if (safe.isEmpty()) safe = "file_" + System.currentTimeMillis();
                if (!safe.contains(".")) safe = safe + ".bin";
                File dir = new File(getFilesDir(), "downloads");
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, safe);
                if (!f.exists()) {
                    String r = saveFileToPhone(url, safe);
                    if (!"ok".equals(r)) return "文件已被清理或已过期，请重新下载";
                }
                final String mime = mimeFor(safe);
                final android.net.Uri uri = android.net.Uri.parse("content://" + LocalFileProvider.AUTHORITY + "/" + safe);
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try {
                            Intent i = new Intent(Intent.ACTION_VIEW);
                            i.setDataAndType(uri, mime);
                            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivity(Intent.createChooser(i, "打开文件"));
                        } catch (Exception ex) {
                            Toast.makeText(MainActivity.this, "打开失败: " + (ex.getMessage() == null ? ex.toString() : ex.getMessage()), Toast.LENGTH_LONG).show();
                        }
                    }
                });
                return "ok";
            } catch (Exception e) {
                return e.getMessage() == null ? e.toString() : e.getMessage();
            }
        }

        private String mimeFor(String name) {
            int dot = name.lastIndexOf('.');
            if (dot >= 0) {
                String m = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
                if (m != null) return m;
            }
            return "application/octet-stream";
        }

        // 全屏预览图片：http 直接打开；dataURL/本地缓存先落临时文件再走 content://
        @JavascriptInterface
        public String openImageViewer(String url) {
            try {
                if (url == null || url.isEmpty()) return "空地址";
                final android.net.Uri uri;
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    uri = android.net.Uri.parse(url);
                } else {
                    byte[] data;
                    String ext = ".png";
                    if (url.startsWith("data:image")) {
                        String b64 = url.substring(url.indexOf(',') + 1);
                        data = Base64.decode(b64, Base64.DEFAULT);
                        if (url.startsWith("data:image/jpeg")) ext = ".jpg";
                    } else if (url.startsWith("file://")) {
                        data = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(url.substring("file://".length())));
                    } else {
                        java.net.URL u = new java.net.URL(url);
                        java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
                        c.setConnectTimeout(10000);
                        c.setReadTimeout(30000);
                        c.setRequestProperty("User-Agent", "codex-phone-bridge");
                        java.io.InputStream in = c.getInputStream();
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                        in.close();
                        data = bos.toByteArray();
                        String ct = c.getContentType();
                        if (ct != null && ct.contains("jpeg")) ext = ".jpg";
                        c.disconnect();
                    }
                    String name = "viewer_" + System.currentTimeMillis() + ext;
                    File f = new File(getCacheDir(), name);
                    java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
                    fos.write(data);
                    fos.close();
                    uri = android.net.Uri.parse("content://" + LocalFileProvider.AUTHORITY + "/" + name);
                }
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try {
                            Intent i = new Intent(Intent.ACTION_VIEW);
                            i.setDataAndType(uri, "image/*");
                            if ("content".equals(uri.getScheme())) {
                                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            }
                            startActivity(i);
                        } catch (Exception ignored) {}
                    }
                });
                return "ok";
            } catch (Exception e) {
                return "打开失败: " + (e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }

        private String ttsDir() {
            File d = new File(getFilesDir(), "tts");
            if (!d.exists()) d.mkdirs();
            return d.getAbsolutePath();
        }

        private String safeTtsId(String id) {
            return (id == null ? "" : id).replaceAll("[^A-Za-z0-9_-]", "_");
        }

        @JavascriptInterface
        public String saveTtsAudio(String id, String b64) {
            try {
                byte[] bytes = Base64.decode(b64 == null ? "" : b64, Base64.DEFAULT);
                File f = new File(ttsDir(), safeTtsId(id) + ".wav");
                FileOutputStream out = new FileOutputStream(f);
                out.write(bytes);
                out.close();
                return "ok";
            } catch (Exception e) {
                return "error: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String loadTtsAudio(String id) {
            try {
                File f = new File(ttsDir(), safeTtsId(id) + ".wav");
                if (!f.exists()) return "";
                byte[] bytes = new byte[(int) f.length()];
                FileInputStream in = new FileInputStream(f);
                int off = 0;
                while (off < bytes.length) {
                    int n = in.read(bytes, off, bytes.length - off);
                    if (n < 0) break;
                    off += n;
                }
                in.close();
                return Base64.encodeToString(bytes, Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void deleteTtsAudio(String id) {
            try {
                File f = new File(ttsDir(), safeTtsId(id) + ".wav");
                if (f.exists()) f.delete();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void deleteTtsByPrefix(String prefix) {
            try {
                File d = new File(ttsDir());
                File[] fs = d.listFiles();
                if (fs == null) return;
                String p = safeTtsId(prefix) + "_";
                for (File f : fs) {
                    if (f.isFile() && f.getName().startsWith(p)) f.delete();
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public String getDeviceId() {
            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String id = p.getString("device_id", "");
            if (id.isEmpty()) {
                id = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
                p.edit().putString("device_id", id).apply();
            }
            return id;
        }

        @JavascriptInterface
        public String getInstalledApps() {
            try {
                PackageManager pm = getPackageManager();
                Intent main = new Intent(Intent.ACTION_MAIN, null);
                main.addCategory(Intent.CATEGORY_LAUNCHER);
                List<ResolveInfo> list = pm.queryIntentActivities(main, 0);
                JSONArray arr = new JSONArray();
                for (ResolveInfo ri : list) {
                    try {
                        JSONObject o = new JSONObject();
                        o.put("label", ri.loadLabel(pm).toString());
                        o.put("package", ri.activityInfo.packageName);
                        arr.put(o);
                    } catch (Exception ignored) {}
                }
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public String uninstallApp(String pkg) {
            try {
                Intent intent = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return "ok";
            } catch (Exception e) {
                return "error: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String openApp(String pkg) {
            try {
                Intent launch = getPackageManager().getLaunchIntentForPackage(pkg);
                if (launch == null) return "error: 未找到启动入口";
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(launch);
                return "ok";
            } catch (Exception e) {
                return "error: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String openAppBackground(String pkg) {
            try {
                Intent launch = getPackageManager().getLaunchIntentForPackage(pkg);
                if (launch == null) return "error: 未找到启动入口";
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(launch);
                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                    @Override public void run() {
                        try {
                            Intent self = new Intent(MainActivity.this, MainActivity.class);
                            self.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                            startActivity(self);
                        } catch (Exception ignored) {}
                    }
                }, 1200);
                return "ok";
            } catch (Exception e) {
                return "error: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String goHome() {
            try {
                Intent home = new Intent(Intent.ACTION_MAIN);
                home.addCategory(Intent.CATEGORY_HOME);
                home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(home);
                return "ok";
            } catch (Exception e) {
                return "error: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String openAppSettings(String pkg) {
            try {
                Intent s = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(s);
                return "ok";
            } catch (Exception e) {
                return "error: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String requestIgnoreBattery() {
            try {
                Intent s = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(s);
                return "ok";
            } catch (Exception e) {
                return "error: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    showSettingsDialog();
                }
            });
        }

        @JavascriptInterface
        public void saveRelayConfig(String room, String password, String updateUrl, String broker) {
            SharedPreferences.Editor e = getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
            e.putString(KEY_MODE, "relay");
            e.putString(KEY_ROOM, room == null ? "" : room.trim().toUpperCase());
            e.putString(KEY_PASSWORD, password == null ? "" : password.trim());
            e.putString(KEY_UPDATE_URL, updateUrl == null ? "" : updateUrl.trim());
            e.putString(KEY_BROKER, (broker == null || broker.trim().isEmpty()) ? RELAY_BROKER : broker.trim());
            e.apply();
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    setupUi();
                }
            });
        }
    }

    private void showSetupScreen() {
        final LinearLayout root = buildSetupForm(null, true, null);
        setContentView(root);
    }

    // 霓虹线稿风：圆角背景 + 1px 描边
    private GradientDrawable roundedBg(int fill, int stroke, float radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setStroke(1, stroke);
        d.setCornerRadius(radius);
        return d;
    }

    private LinearLayout buildSetupForm(final String[] initial, final boolean firstRun, final AlertDialog dialogToDismiss) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(56, 40, 56, 40);
        root.setBackgroundColor(Color.parseColor("#0B0E14"));

        TextView title = new TextView(this);
        title.setText("鳍点AI");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        root.addView(title, lp());

        TextView sub = new TextView(this);
        sub.setText(firstRun ? "先选择连接方式，再填写信息" : "修改连接设置");
        sub.setTextColor(Color.parseColor("#8B949E"));
        sub.setGravity(Gravity.CENTER);
        root.addView(sub, lp());

        final String[] mode = { initial != null ? initial[0] : "lan" };

        final Button lanBtn = new Button(this);
        lanBtn.setText("局域网连接");
        final Button relayBtn = new Button(this);
        relayBtn.setText("中继连接（流量可用）");
        LinearLayout modeRow = new LinearLayout(this);
        modeRow.setOrientation(LinearLayout.HORIZONTAL);
        modeRow.addView(lanBtn, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        modeRow.addView(relayBtn, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(modeRow, lp());

        final TextView keyLabel = new TextView(this);
        keyLabel.setText("一键配置密钥（新用户推荐：填电脑窗口里的密钥即可自动配置）");
        keyLabel.setTextColor(Color.parseColor("#00D2A0"));
        root.addView(keyLabel, lp());

        final EditText keyInput = new EditText(this);
        keyInput.setHint("输入密钥自动配置");
        styleInput(keyInput);
        root.addView(keyInput, lp());

        final Button keyBtn = new Button(this);
        keyBtn.setText("一键配置");
        keyBtn.setBackground(roundedBg(Color.parseColor("#00D2A0"), Color.TRANSPARENT, 999f));
        keyBtn.setTextColor(Color.parseColor("#06231C"));
        root.addView(keyBtn, lp());

        final EditText urlInput = new EditText(this);
        urlInput.setHint("电脑地址，例如 http://192.168.1.100:8787");
        if (initial != null && initial.length > 1 && !initial[1].isEmpty()) urlInput.setText(initial[1]);
        styleInput(urlInput);
        root.addView(urlInput, lp());

        final EditText roomInput = new EditText(this);
        roomInput.setHint("配对码（电脑窗口里显示）");
        if (initial != null && initial.length > 2 && !initial[2].isEmpty()) roomInput.setText(initial[2]);
        styleInput(roomInput);
        root.addView(roomInput, lp());

        final EditText pwInput = new EditText(this);
        pwInput.setHint("访问密码");
        if (initial != null && initial.length > 3 && !initial[3].isEmpty()) pwInput.setText(initial[3]);
        styleInput(pwInput);
        root.addView(pwInput, lp());

        final EditText updateInput = new EditText(this);
        updateInput.setHint("更新地址（可选，version.json 的网址）");
        if (initial != null && initial.length > 4 && !initial[4].isEmpty()) updateInput.setText(initial[4]);
        styleInput(updateInput);
        root.addView(updateInput, lp());

        final TextView effortLabel = new TextView(this);
        effortLabel.setText("推理强度（影响速度与 token 消耗）");
        effortLabel.setTextColor(Color.parseColor("#8B949E"));
        root.addView(effortLabel, lp());

        final String[] effortLabels = {"极低", "轻度", "中", "高", "极高", "最高"};
        final String[] effortValues = {"minimal", "low", "medium", "high", "xhigh", "max"};
        final Spinner effortSpinner = new Spinner(this);
        ArrayAdapter<String> effortAdapter = new ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, effortLabels);
        effortAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        effortSpinner.setAdapter(effortAdapter);
        String curEffort = (initial != null && initial.length > 5 && initial[5] != null) ? initial[5] : "medium";
        int effortSel = 2;
        for (int i = 0; i < effortValues.length; i++) {
            if (effortValues[i].equals(curEffort)) { effortSel = i; break; }
        }
        effortSpinner.setSelection(effortSel);
        root.addView(effortSpinner, lp());

        final TextView autoSpeakLabel = new TextView(this);
        autoSpeakLabel.setText("自动朗读 AI 回复（每条回复仍会生成语音）");
        autoSpeakLabel.setTextColor(Color.parseColor("#8B949E"));
        root.addView(autoSpeakLabel, lp());

        final CheckBox autoSpeakBox = new CheckBox(this);
        autoSpeakBox.setText("开启自动朗读");
        autoSpeakBox.setTextColor(Color.parseColor("#E6EDF3"));
        boolean curAutoSpeak = initial == null || initial.length <= 7 || !"false".equalsIgnoreCase(initial[7]);
        autoSpeakBox.setChecked(curAutoSpeak);
        root.addView(autoSpeakBox, lp());

        final TextView capLabel = new TextView(this);
        capLabel.setText("能力开关（默认关闭，未开启时 AI 会提示去设置开启）");
        capLabel.setTextColor(Color.parseColor("#8B949E"));
        root.addView(capLabel, lp());

        final CheckBox capDeviceBox = new CheckBox(this);
        capDeviceBox.setText("设备状态查询（型号/电量/网络/存储）");
        capDeviceBox.setTextColor(Color.parseColor("#E6EDF3"));
        boolean curDevice = initial != null && initial.length > 8 && "true".equalsIgnoreCase(initial[8]);
        capDeviceBox.setChecked(curDevice);
        root.addView(capDeviceBox, lp());

        final CheckBox capComfyBox = new CheckBox(this);
        capComfyBox.setText("图像生成（ComfyUI，需电脑运行 ComfyUI）");
        capComfyBox.setTextColor(Color.parseColor("#E6EDF3"));
        boolean curComfy = initial != null && initial.length > 9 && "true".equalsIgnoreCase(initial[9]);
        capComfyBox.setChecked(curComfy);
        root.addView(capComfyBox, lp());

        final EditText brokerInput = new EditText(this);
        brokerInput.setHint("中继服务器地址（一般不用改）");
        if (initial != null && initial.length > 6 && !initial[6].isEmpty()) brokerInput.setText(initial[6]);
        styleInput(brokerInput);
        root.addView(brokerInput, lp());

        final Button updateBtn = new Button(this);
        updateBtn.setText("检查更新");
        updateBtn.setBackground(roundedBg(Color.parseColor("#151A23"), Color.parseColor("#4000D2A0"), 999f));
        updateBtn.setTextColor(Color.parseColor("#E6EDF3"));
        root.addView(updateBtn, lp());

        Button save = new Button(this);
        save.setText("保存并连接");
        save.setBackground(roundedBg(Color.parseColor("#00D2A0"), Color.TRANSPARENT, 999f));
        save.setTextColor(Color.parseColor("#06231C"));
        root.addView(save, lp());

        final TextView lanError = new TextView(this);
        lanError.setTextColor(Color.parseColor("#FF5D5D"));
        lanError.setTextSize(13);
        lanError.setGravity(Gravity.CENTER);
        lanError.setPadding(0, 10, 0, 0);
        lanError.setVisibility(View.GONE);
        root.addView(lanError, lp());

        final TextView aboutRow = new TextView(this);
        aboutRow.setText("关于本软件");
        aboutRow.setTextColor(Color.parseColor("#E6EDF3"));
        aboutRow.setGravity(Gravity.CENTER);
        aboutRow.setBackground(roundedBg(Color.parseColor("#151A23"), Color.parseColor("#4000D2A0"), 12f));
        aboutRow.setPadding(0, 12, 0, 12);
        LinearLayout.LayoutParams aboutLp = lp();
        aboutLp.topMargin = 10;
        aboutRow.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showAboutDialog(); }
        });
        root.addView(aboutRow, aboutLp);

        final Runnable applyMode = new Runnable() {
            @Override
            public void run() {
                boolean relay = "relay".equals(mode[0]);
                urlInput.setVisibility(relay ? View.GONE : View.VISIBLE);
                roomInput.setVisibility(relay ? View.VISIBLE : View.GONE);
                pwInput.setVisibility(relay ? View.VISIBLE : View.GONE);
                lanBtn.setBackground(roundedBg(Color.parseColor(relay ? "#151A23" : "#00D2A0"), Color.parseColor(relay ? "#4000D2A0" : "#00000000"), 999f));
                lanBtn.setTextColor(Color.parseColor(relay ? "#8B949E" : "#06231C"));
                relayBtn.setBackground(roundedBg(Color.parseColor(relay ? "#00D2A0" : "#151A23"), Color.parseColor(relay ? "#00000000" : "#4000D2A0"), 999f));
                relayBtn.setTextColor(Color.parseColor(relay ? "#06231C" : "#8B949E"));
            }
        };
        lanBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { mode[0] = "lan"; applyMode.run(); }
        });
        relayBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { mode[0] = "relay"; applyMode.run(); }
        });
        applyMode.run();

        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String url = urlInput.getText().toString().trim();
                String room = roomInput.getText().toString().trim().toUpperCase();
                String pw = pwInput.getText().toString().trim();
                if ("lan".equals(mode[0]) && url.isEmpty()) {
                    Toast.makeText(MainActivity.this, "请输入电脑地址", Toast.LENGTH_SHORT).show();
                    return;
                }
                String lowerUrl = url.toLowerCase();
                if ("lan".equals(mode[0]) && (lowerUrl.startsWith("localhost") || lowerUrl.startsWith("127.0.0.1")
                        || lowerUrl.indexOf("://localhost") >= 0 || lowerUrl.indexOf("://127.0.0.1") >= 0)) {
                    Toast.makeText(MainActivity.this, "请填电脑的局域网 IP，例如 http://192.168.1.100:8787", Toast.LENGTH_LONG).show();
                    return;
                }
                if ("relay".equals(mode[0])) {
                    if (room.isEmpty() || pw.isEmpty()) {
                        Toast.makeText(MainActivity.this, "请输入配对码和密码", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    if (!url.startsWith("http")) url = "";
                    finishSave(mode[0], url, room, pw,
                            updateInput.getText().toString().trim(),
                            effortValues[effortSpinner.getSelectedItemPosition()],
                            autoSpeakBox.isChecked(), capDeviceBox.isChecked(),
                            capComfyBox.isChecked(), brokerInput.getText().toString().trim(), dialogToDismiss);
                    return;
                }
                // 局域网：先补全协议，再做保存前预检（TCP 4 秒超时），失败留在设置页
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    url = "http://" + url;
                }
                final String lanUrl = url;
                final String lanEffort = effortValues[effortSpinner.getSelectedItemPosition()];
                final boolean lanAutoSpeak = autoSpeakBox.isChecked();
                final boolean lanCapDevice = capDeviceBox.isChecked();
                final boolean lanCapComfy = capComfyBox.isChecked();
                final String lanUpdateUrl = updateInput.getText().toString().trim();
                final String lanBroker = brokerInput.getText().toString().trim();
                save.setEnabled(false);
                save.setText("正在检测地址…");
                lanError.setVisibility(View.GONE);
                new Thread(new Runnable() {
                    @Override public void run() {
                        final String err = checkLanAddress(lanUrl);
                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                save.setEnabled(true);
                                save.setText("保存并连接");
                                if (err != null) {
                                    lanError.setText(err);
                                    lanError.setVisibility(View.VISIBLE);
                                    return;
                                }
                                finishSave(mode[0], lanUrl, room, pw, lanUpdateUrl,
                                        lanEffort, lanAutoSpeak, lanCapDevice, lanCapComfy, lanBroker, dialogToDismiss);
                            }
                        });
                    }
                }).start();
            }
        });
        keyBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                pendingKey = keyInput.getText().toString().trim();
                if (pendingKey.isEmpty()) {
                    Toast.makeText(MainActivity.this, "请先输入一键配置密钥", Toast.LENGTH_SHORT).show();
                    return;
                }
                openQuickConfigWebView();
            }
        });
        updateBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                checkUpdate(updateInput.getText().toString().trim());
            }
        });

        return root;
    }

    private void checkUpdate(final String updateUrl) {
        if (updateUrl.isEmpty()) {
            Toast.makeText(this, "请先填写更新地址", Toast.LENGTH_SHORT).show();
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                String msg = "";
                final String[] apkUrl = { "" };
                final java.util.List<String> urlList = new java.util.ArrayList<String>();
                urlList.add(updateUrl);
                try {
                    java.net.URL u0 = new java.net.URL(updateUrl);
                    String host = u0.getHost();
                    String path = u0.getPath();
                    if ("raw.githubusercontent.com".equalsIgnoreCase(host)) {
                        String[] seg = path.split("/");
                        if (seg.length >= 4 && path.endsWith("/version.json")) {
                            String ghUser = seg[1];
                            String ghRepo = seg[2];
                            String ghBranch = seg[3];
                            urlList.add("https://api.github.com/repos/" + ghUser + "/" + ghRepo + "/contents/version.json");
                            urlList.add("https://cdn.jsdelivr.net/gh/" + ghUser + "/" + ghRepo + "@" + ghBranch + "/version.json");
                            urlList.add("https://github.com/" + ghUser + "/" + ghRepo + "/raw/" + ghBranch + "/version.json");
                        }
                    } else if ("github.com".equalsIgnoreCase(host)) {
                        String[] seg = path.split("/");
                        if (seg.length >= 5 && "raw".equals(seg[3]) && path.endsWith("/version.json")) {
                            String ghUser = seg[1];
                            String ghRepo = seg[2];
                            String ghBranch = seg[4];
                            urlList.add("https://api.github.com/repos/" + ghUser + "/" + ghRepo + "/contents/version.json");
                            urlList.add("https://raw.githubusercontent.com/" + ghUser + "/" + ghRepo + "/" + ghBranch + "/version.json");
                            urlList.add("https://cdn.jsdelivr.net/gh/" + ghUser + "/" + ghRepo + "@" + ghBranch + "/version.json");
                        }
                    }
                } catch (Exception ignored) {}
                final String[] urls = urlList.toArray(new String[0]);
                String lastErr = "";
                String staleMsg = "";
                try {
                    boolean ok = false;
                    for (String u : urls) {
                        try {
                            java.net.URL url = new java.net.URL(u);
                            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                            conn.setConnectTimeout(8000);
                            conn.setReadTimeout(8000);
                            conn.setRequestProperty("User-Agent", "codex-phone-bridge");
                            if (u.startsWith("https://api.github.com/")) {
                                conn.setRequestProperty("Accept", "application/vnd.github.raw");
                            }
                            java.io.InputStream in = conn.getInputStream();
                            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                            byte[] buf = new byte[4096];
                            int n;
                            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                            in.close();
                            JSONObject o = new JSONObject(new String(bos.toByteArray(), "UTF-8"));
                            String v = o.optString("version", "");
                            apkUrl[0] = o.optString("apk", "");
                            if (v.isEmpty()) throw new Exception("版本信息为空");
                            int cmp = compareVersion(v, APP_VERSION);
                            if (cmp == 0) {
                                msg = "已是最新版本 v" + APP_VERSION + "（服务器 v" + v + "）";
                            } else if (apkUrl[0].isEmpty()) {
                                msg = "发现服务器版本 v" + v + "，但缺少下载地址";
                            } else if (cmp > 0) {
                                msg = "发现新版本 v" + v;
                            } else {
                                staleMsg = "已是最新版本 v" + APP_VERSION + "（服务器版本较旧 v" + v + "）";
                                lastErr = "";
                                continue;
                            }
                            ok = true;
                            break;
                        } catch (Exception e) {
                            lastErr = (e.getMessage() == null) ? "" : e.getMessage();
                        }
                    }
                    if (!ok) {
                        if (!staleMsg.isEmpty()) {
                            msg = staleMsg;
                        } else {
                            throw new Exception(lastErr.isEmpty() ? "网络不可达" : lastErr);
                        }
                    }
                } catch (Exception e) {
                    msg = "检查失败: " + e.getMessage() + "（请检查网络，或开启 VPN/代理后重试）";
                }
                final String finalMsg = msg;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, finalMsg, Toast.LENGTH_LONG).show();
                        if (!apkUrl[0].isEmpty() && finalMsg.startsWith("发现")) {
                            downloadAndInstall(apkUrl[0]);
                        }
                    }
                });
            }
        }).start();
    }

    private int compareVersion(String a, String b) {
        String[] as = a.split("\\.");
        String[] bs = b.split("\\.");
        int n = Math.max(as.length, bs.length);
        for (int i = 0; i < n; i++) {
            int x = i < as.length ? parseIntSafe(as[i]) : 0;
            int y = i < bs.length ? parseIntSafe(bs[i]) : 0;
            if (x != y) return x < y ? -1 : 1;
        }
        return 0;
    }

    private int parseIntSafe(String s) {
        try { return Integer.parseInt(s); } catch (Exception e) { return 0; }
    }

    private void downloadAndInstall(final String apkUrl) {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
            req.setTitle("鳍点AI");
            req.setDescription("正在下载新版 APK…");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "CodexPhoneBridge.apk");
            final long downloadId = dm.enqueue(req);
            registerReceiver(new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    long got = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (got != downloadId) return;
                    try {
                        unregisterReceiver(this);
                    } catch (Exception ignored) {}
                    Uri uri = dm.getUriForDownloadedFile(downloadId);
                    if (uri == null) {
                        Toast.makeText(MainActivity.this, "下载完成但找不到文件", Toast.LENGTH_LONG).show();
                        return;
                    }
                    try {
                        Intent install = new Intent(Intent.ACTION_VIEW);
                        install.setDataAndType(uri, "application/vnd.android.package-archive");
                        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(install);
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "安装失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                }
            }, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
        } catch (Exception e) {
            Toast.makeText(this, "下载失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void setupUi() {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        final String mode = prefs.getString(KEY_MODE, "lan");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0B0E14"));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        web.clearCache(true);
        s.setJavaScriptEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new JsBridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                lanWebLoading = true;
                view.loadUrl(url);
                return true;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                lanWebLoading = false;
                if (lanLoadTimeout != null) mainHandler.removeCallbacks(lanLoadTimeout);
            }
            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                showLanErrorOverlay();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }
                fileChooserCallback = filePathCallback;
                try {
                    Intent intent = fileChooserParams.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    fileChooserCallback = null;
                    return false;
                }
            }
        });

        FrameLayout webWrap = new FrameLayout(this);
        webWrap.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        lanErrorOverlay = buildLanErrorOverlay();
        webWrap.addView(lanErrorOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        lanErrorOverlay.setVisibility(View.GONE);
        root.addView(webWrap, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        if ("relay".equals(mode)) {
            web.loadUrl("file:///android_asset/www/index.html");
        } else {
            final String lanUrl = prefs.getString(KEY_URL, "").trim();
            if (lanUrl.isEmpty()) {
                showSettingsDialog();
                return;
            }
            web.loadUrl(lanUrl);
            lanLoadTimeout = new Runnable() {
                @Override public void run() {
                    showLanErrorOverlay();
                }
            };
            mainHandler.postDelayed(lanLoadTimeout, 8000);
        }

    }

    // 局域网加载失败的原生覆盖层（替代弹窗：挂起/超时时也能兜住，不白屏）
    private View buildLanErrorOverlay() {
        LinearLayout ov = new LinearLayout(this);
        ov.setOrientation(LinearLayout.VERTICAL);
        ov.setGravity(Gravity.CENTER);
        ov.setBackgroundColor(Color.parseColor("#0B0E14"));
        ov.setPadding(48, 40, 48, 40);

        TextView title = new TextView(this);
        title.setText("无法加载该页面");
        title.setTextColor(Color.parseColor("#E6EDF3"));
        title.setTextSize(20);
        title.setGravity(Gravity.CENTER);
        ov.addView(title, lp());

        TextView sub = new TextView(this);
        sub.setText("请检查：\n\n1. 电脑端桥接服务是否已启动（start.bat）；\n2. 地址是否为电脑的局域网 IP（localhost 指向的是手机自己）；\n3. 手机和电脑是否连接同一个 Wi-Fi。");
        sub.setTextColor(Color.parseColor("#8B949E"));
        sub.setTextSize(14);
        sub.setLineSpacing(0, 1.6f);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, 20, 0, 28);
        ov.addView(sub, lp());

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setBackground(roundedBg(Color.parseColor("#00D2A0"), Color.TRANSPARENT, 999f));
        retry.setTextColor(Color.parseColor("#06231C"));
        retry.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                hideLanErrorOverlay();
                try { if (web != null) web.stopLoading(); } catch (Exception ignored) {}
                if (web != null) web.reload();
                restartLanLoadTimeout();
            }
        });
        ov.addView(retry, lp());

        Button back = new Button(this);
        back.setText("返回设置");
        back.setBackground(roundedBg(Color.parseColor("#151A23"), Color.parseColor("#4000D2A0"), 999f));
        back.setTextColor(Color.parseColor("#E6EDF3"));
        LinearLayout.LayoutParams blp = lp();
        blp.topMargin = 10;
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                hideLanErrorOverlay();
                try { if (web != null) web.stopLoading(); } catch (Exception ignored) {}
                showSettingsDialog();
            }
        });
        ov.addView(back, blp);
        return ov;
    }

    private void showLanErrorOverlay() {
        if (lanErrorOverlay == null) return;
        if (!"lan".equals(getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_MODE, "lan"))) return;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try { lanErrorOverlay.setVisibility(View.VISIBLE); } catch (Exception ignored) {}
            }
        });
    }

    private void hideLanErrorOverlay() {
        if (lanErrorOverlay == null) return;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try { lanErrorOverlay.setVisibility(View.GONE); } catch (Exception ignored) {}
            }
        });
    }

    private void restartLanLoadTimeout() {
        if (lanLoadTimeout != null) mainHandler.removeCallbacks(lanLoadTimeout);
        lanLoadTimeout = new Runnable() {
            @Override public void run() {
                showLanErrorOverlay();
            }
        };
        mainHandler.postDelayed(lanLoadTimeout, 8000);
    }

    // 保存前预检：TCP 连通性测试，4 秒超时
    private String checkLanAddress(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            String host = u.getHost();
            int port = u.getPort();
            if (port < 0) port = 80;
            Socket sock = new Socket();
            try {
                sock.connect(new InetSocketAddress(host, port), 4000);
            } finally {
                try { sock.close(); } catch (Exception ignored) {}
            }
            return null;
        } catch (UnknownHostException e) {
            return "域名无法解析，请检查地址拼写";
        } catch (SocketTimeoutException e) {
            return "地址不可达，请检查 IP 是否正确、手机和电脑是否连接同一个 Wi-Fi";
        } catch (ConnectException e) {
            return "电脑端桥接服务未启动，请先运行 start.bat";
        } catch (Exception e) {
            return "无法连接该地址：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }

    private void finishSave(String mode, String url, String room, String pw, String updateUrl,
                            String effort, boolean autoSpeak, boolean capDevice, boolean capComfy, String broker, AlertDialog dlg) {
        SharedPreferences.Editor e = getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        e.putString(KEY_MODE, mode);
        e.putString(KEY_URL, url);
        e.putString(KEY_ROOM, room);
        e.putString(KEY_PASSWORD, pw);
        e.putString(KEY_UPDATE_URL, updateUrl);
        e.putString(KEY_EFFORT, effort);
        e.putBoolean(KEY_AUTO_SPEAK, autoSpeak);
        e.putBoolean(KEY_CAP_DEVICE_STATUS, capDevice);
        e.putBoolean(KEY_CAP_IMAGE_GEN, capComfy);
        e.putString(KEY_BROKER, broker.isEmpty() ? RELAY_BROKER : broker);
        e.apply();
        setupUi();
        if (dlg != null) dlg.dismiss();
    }

    @Override
    public void onBackPressed() {
        if (lanErrorOverlay != null && lanErrorOverlay.getVisibility() == View.VISIBLE) {
            showSettingsDialog();
            return;
        }
        boolean lan = "lan".equals(getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_MODE, "lan"));
        if (lan && web != null && (lanWebLoading || !web.canGoBack())) {
            try { web.stopLoading(); } catch (Exception ignored) {}
            showSettingsDialog();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    private void showSettingsDialog() {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        final String[] initial = new String[]{
                prefs.getString(KEY_MODE, "lan"),
                prefs.getString(KEY_URL, ""),
                prefs.getString(KEY_ROOM, ""),
                prefs.getString(KEY_PASSWORD, ""),
                prefs.getString(KEY_UPDATE_URL, ""),
                prefs.getString(KEY_EFFORT, "medium"),
                prefs.getString(KEY_BROKER, RELAY_BROKER),
                String.valueOf(prefs.getBoolean(KEY_AUTO_SPEAK, true)),
                String.valueOf(prefs.getBoolean(KEY_CAP_DEVICE_STATUS, false)),
                String.valueOf(prefs.getBoolean(KEY_CAP_IMAGE_GEN, false))
        };
        final AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle("连接设置")
                .create();
        dlg.setView(buildSetupForm(initial, false, dlg));
        dlg.show();
    }

    private void showAboutDialog() {
        final LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(48, 40, 48, 40);
        root.setBackgroundColor(Color.parseColor("#11141D"));

        final ImageView icon = new ImageView(this);
        int iconId = getResources().getIdentifier("ic_launcher", "drawable", getPackageName());
        if (iconId != 0) icon.setImageResource(iconId);
        LinearLayout.LayoutParams iconLp = new LinearLayout.LayoutParams(96, 96);
        iconLp.bottomMargin = 12;
        root.addView(icon, iconLp);

        final TextView ver = new TextView(this);
        ver.setText("v" + APP_VERSION);
        ver.setTextColor(Color.parseColor("#8B949E"));
        ver.setTypeface(Typeface.MONOSPACE);
        ver.setTextSize(12);
        ver.setGravity(Gravity.CENTER);
        root.addView(ver, lp());

        TextView quote = new TextView(this);
        quote.setText("初，帝以一手机起家，\n夜召 AI 谋事，遂有天下。\n然，天下未定，亦未一统；\n不求独坐江山，惟愿人民安康富庶。");
        quote.setTextColor(Color.parseColor("#E6EDF3"));
        quote.setTextSize(15);
        quote.setLineSpacing(0, 1.8f);
        quote.setGravity(Gravity.CENTER);
        quote.setPadding(0, 22, 0, 22);
        root.addView(quote, lp());

        View divider = new View(this);
        divider.setBackgroundColor(Color.parseColor("#2600D2A0"));
        root.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));

        TextView link = new TextView(this);
        link.setText("github.com/oen1day/codex-phone-bridge");
        link.setTextColor(Color.parseColor("#00D2A0"));
        link.setTextSize(13);
        link.setGravity(Gravity.CENTER);
        link.setPadding(0, 18, 0, 0);
        link.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/oen1day/codex-phone-bridge"));
                    startActivity(i);
                } catch (Exception ignored) {}
            }
        });
        root.addView(link, lp());

        final Handler h = new Handler(Looper.getMainLooper());
        final Runnable openHidden = new Runnable() {
            @Override public void run() {
                showHiddenDialog();
            }
        };
        View.OnTouchListener hold3s = new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent ev) {
                if (ev.getAction() == MotionEvent.ACTION_DOWN) {
                    h.postDelayed(openHidden, 3000);
                } else if (ev.getAction() == MotionEvent.ACTION_UP || ev.getAction() == MotionEvent.ACTION_CANCEL) {
                    h.removeCallbacks(openHidden);
                }
                return false;
            }
        };
        View.OnClickListener tapVersion = new View.OnClickListener() {
            @Override public void onClick(View v) {
                Toast.makeText(MainActivity.this, "鳍点AI v" + APP_VERSION, Toast.LENGTH_SHORT).show();
            }
        };
        ver.setOnClickListener(tapVersion);
        icon.setOnClickListener(tapVersion);
        ver.setOnTouchListener(hold3s);
        icon.setOnTouchListener(hold3s);

        final AlertDialog dlg = new AlertDialog.Builder(this).setView(root).create();
        dlg.show();
    }

    private void showHiddenDialog() {
        final LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(48, 36, 48, 36);
        root.setBackgroundColor(Color.parseColor("#11141D"));

        TextView title = new TextView(this);
        title.setText("鳍点AI · 来历");
        title.setTextColor(Color.parseColor("#00D2A0"));
        title.setTextSize(18);
        title.setGravity(Gravity.CENTER);
        root.addView(title, lp());

        TextView quote = new TextView(this);
        quote.setText("初，帝以一手机起家，\n夜召 AI 谋事，遂有天下。\n然，天下未定，亦未一统；\n不求独坐江山，惟愿人民安康富庶。");
        quote.setTextColor(Color.parseColor("#E6EDF3"));
        quote.setTextSize(15);
        quote.setLineSpacing(0, 1.8f);
        quote.setGravity(Gravity.CENTER);
        quote.setPadding(0, 20, 0, 16);
        root.addView(quote, lp());

        TextView author = new TextView(this);
        author.setText("作者署名：add");
        author.setTextColor(Color.parseColor("#8B949E"));
        author.setTextSize(13);
        author.setGravity(Gravity.CENTER);
        root.addView(author, lp());

        TextView decl = new TextView(this);
        decl.setText("本软件为个人开源项目，作者保留署名权，未经作者授权禁止用于商业用途；如果你能看到此页，说明你值得知道它的来历。");
        decl.setTextColor(Color.parseColor("#E6EDF3"));
        decl.setTextSize(13);
        decl.setLineSpacing(0, 1.6f);
        decl.setPadding(0, 18, 0, 20);
        root.addView(decl, lp());

        Button close = new Button(this);
        close.setText("关闭");
        close.setBackground(roundedBg(Color.parseColor("#00D2A0"), Color.TRANSPARENT, 999f));
        close.setTextColor(Color.parseColor("#06231C"));
        root.addView(close, lp());

        final AlertDialog dlg = new AlertDialog.Builder(this).setView(root).create();
        close.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { dlg.dismiss(); }
        });
        dlg.show();
    }

    private void openQuickConfigWebView() {
        WebView qc = new WebView(this);
        WebSettings s = qc.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        qc.addJavascriptInterface(new QuickConfigBridge(), "AndroidBridge");
        qc.setWebViewClient(new WebViewClient());
        qc.loadUrl("file:///android_asset/www/quickconfig.html");
        setContentView(qc);
    }

    private class QuickConfigBridge {
        @JavascriptInterface
        public String getPendingKey() {
            return pendingKey == null ? "" : pendingKey;
        }

        @JavascriptInterface
        public void quickConfigSuccess(String room, String password, String updateUrl, String broker) {
            SharedPreferences.Editor e = getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
            e.putString(KEY_MODE, "relay");
            e.putString(KEY_ROOM, room == null ? "" : room.trim().toUpperCase());
            e.putString(KEY_PASSWORD, password == null ? "" : password.trim());
            e.putString(KEY_UPDATE_URL, updateUrl == null ? "" : updateUrl.trim());
            e.putString(KEY_BROKER, (broker == null || broker.trim().isEmpty()) ? RELAY_BROKER : broker.trim());
            e.apply();
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, "一键配置成功，正在连接…", Toast.LENGTH_LONG).show();
                    setupUi();
                }
            });
        }

        @JavascriptInterface
        public void quickConfigDone(boolean ok, String msg) {
            final String m = msg == null ? "" : msg;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, m.isEmpty() ? "一键配置失败" : m, Toast.LENGTH_LONG).show();
                    showSetupScreen();
                }
            });
        }
    }

    private LinearLayout.LayoutParams lp() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private void styleInput(EditText input) {
        input.setTextColor(Color.parseColor("#E6EDF3"));
        input.setHintTextColor(Color.parseColor("#5C6670"));
        input.setSingleLine(true);
        input.setPadding(16, 12, 16, 12);
        input.setBackground(roundedBg(Color.parseColor("#151A23"), Color.parseColor("#4000D2A0"), 12f));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (fileChooserCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    results = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            fileChooserCallback.onReceiveValue(results);
            fileChooserCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

}
