package com.local.codexbridge;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

// 轻量文件提供者：把缓存目录里的临时图片/文件以及 App 下载目录以 content:// 暴露给系统打开
public class LocalFileProvider extends ContentProvider {
    public static final String AUTHORITY = "com.local.codexbridge.localprovider";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        String name = uri.getLastPathSegment();
        if (name == null) return "application/octet-stream";
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String m = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
            if (m != null) return m;
        }
        return "application/octet-stream";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null) throw new FileNotFoundException("empty name");
        File f = resolve(name);
        if (f == null || !f.exists()) throw new FileNotFoundException("not found: " + name);
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    private File resolve(String name) {
        File inCache = new File(getContext().getCacheDir(), name);
        if (inCache.exists()) return inCache;
        File inDownloads = new File(getContext().getFilesDir(), "downloads/" + name);
        if (inDownloads.exists()) return inDownloads;
        return null;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
