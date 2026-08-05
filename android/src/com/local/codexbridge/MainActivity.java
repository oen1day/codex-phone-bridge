package com.local.codexbridge;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Environment;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
import android.view.Gravity;
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
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
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
    private static final String KEY_BROKER = "broker";
    private static final String RELAY_BROKER = "wss://broker.emqx.io:8084/mqtt";
    private static final String APP_VERSION = "9.7";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private ValueCallback<Uri[]> fileChooserCallback;
    private String pendingKey = "";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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

    private LinearLayout buildSetupForm(final String[] initial, final boolean firstRun, final AlertDialog dialogToDismiss) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(56, 40, 56, 40);
        root.setBackgroundColor(Color.parseColor("#0f1115"));

        TextView title = new TextView(this);
        title.setText("Codex 手机遥控");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        root.addView(title, lp());

        TextView sub = new TextView(this);
        sub.setText(firstRun ? "先选择连接方式，再填写信息" : "修改连接设置");
        sub.setTextColor(Color.parseColor("#9aa3b2"));
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
        keyLabel.setTextColor(Color.parseColor("#22d3a5"));
        root.addView(keyLabel, lp());

        final EditText keyInput = new EditText(this);
        keyInput.setHint("输入密钥自动配置");
        styleInput(keyInput);
        root.addView(keyInput, lp());

        final Button keyBtn = new Button(this);
        keyBtn.setText("一键配置");
        keyBtn.setBackgroundColor(Color.parseColor("#10a37f"));
        keyBtn.setTextColor(Color.WHITE);
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
        effortLabel.setTextColor(Color.parseColor("#9aa3b2"));
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
        autoSpeakLabel.setTextColor(Color.parseColor("#9aa3b2"));
        root.addView(autoSpeakLabel, lp());

        final CheckBox autoSpeakBox = new CheckBox(this);
        autoSpeakBox.setText("开启自动朗读");
        autoSpeakBox.setTextColor(Color.WHITE);
        boolean curAutoSpeak = initial == null || initial.length <= 7 || !"false".equalsIgnoreCase(initial[7]);
        autoSpeakBox.setChecked(curAutoSpeak);
        root.addView(autoSpeakBox, lp());

        final EditText brokerInput = new EditText(this);
        brokerInput.setHint("中继服务器地址（一般不用改）");
        if (initial != null && initial.length > 6 && !initial[6].isEmpty()) brokerInput.setText(initial[6]);
        styleInput(brokerInput);
        root.addView(brokerInput, lp());

        final Button updateBtn = new Button(this);
        updateBtn.setText("检查更新");
        updateBtn.setBackgroundColor(Color.parseColor("#2a2f3a"));
        updateBtn.setTextColor(Color.WHITE);
        root.addView(updateBtn, lp());

        Button save = new Button(this);
        save.setText("保存并连接");
        save.setBackgroundColor(Color.parseColor("#10a37f"));
        save.setTextColor(Color.WHITE);
        root.addView(save, lp());

        final Runnable applyMode = new Runnable() {
            @Override
            public void run() {
                boolean relay = "relay".equals(mode[0]);
                urlInput.setVisibility(relay ? View.GONE : View.VISIBLE);
                roomInput.setVisibility(relay ? View.VISIBLE : View.GONE);
                pwInput.setVisibility(relay ? View.VISIBLE : View.GONE);
                lanBtn.setBackgroundColor(Color.parseColor(relay ? "#2a2f3a" : "#10a37f"));
                relayBtn.setBackgroundColor(Color.parseColor(relay ? "#10a37f" : "#2a2f3a"));
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
                if ("relay".equals(mode[0])) {
                    if (room.isEmpty() || pw.isEmpty()) {
                        Toast.makeText(MainActivity.this, "请输入配对码和密码", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    if (!url.startsWith("http")) url = "";
                } else if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    url = "http://" + url;
                }
                SharedPreferences.Editor e = getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
                e.putString(KEY_MODE, mode[0]);
                e.putString(KEY_URL, url);
                e.putString(KEY_ROOM, room);
                e.putString(KEY_PASSWORD, pw);
                e.putString(KEY_UPDATE_URL, updateInput.getText().toString().trim());
                e.putString(KEY_EFFORT, effortValues[effortSpinner.getSelectedItemPosition()]);
                e.putBoolean(KEY_AUTO_SPEAK, autoSpeakBox.isChecked());
                String brokerVal = brokerInput.getText().toString().trim();
                e.putString(KEY_BROKER, brokerVal.isEmpty() ? RELAY_BROKER : brokerVal);
                e.apply();
                setupUi();
                if (dialogToDismiss != null) dialogToDismiss.dismiss();
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
            req.setTitle("Codex 手机遥控");
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
        root.setBackgroundColor(Color.parseColor("#0f1115"));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        web.clearCache(true);
        s.setJavaScriptEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        if ("relay".equals(mode)) {
            web.addJavascriptInterface(new JsBridge(), "AndroidBridge");
        }
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                view.loadUrl(url);
                return true;
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

        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        if ("relay".equals(mode)) {
            web.loadUrl("file:///android_asset/www/index.html");
        } else {
            web.loadUrl(prefs.getString(KEY_URL, ""));
        }

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
                String.valueOf(prefs.getBoolean(KEY_AUTO_SPEAK, true))
        };
        final AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle("连接设置")
                .create();
        dlg.setView(buildSetupForm(initial, false, dlg));
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
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.parseColor("#9aa3b2"));
        input.setSingleLine(true);
        input.setPadding(12, 12, 12, 12);
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

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
