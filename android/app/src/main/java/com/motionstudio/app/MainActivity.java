package com.motionstudio.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Single-activity host for the Motion Studio editor.
 *
 * The whole editor UI (home, projects, effects browser and the
 * multi-track timeline) lives in app/src/main/assets/www and runs inside a
 * WebView. Media is chosen through the system file picker, decoded on device
 * and stored with IndexedDB, so nothing ever leaves the phone.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/www/index.html";
    private static final int REQUEST_FILE_CHOOSER = 1001;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyChromeColors(getWindow());

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#090a0f"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setDefaultTextEncodingName("utf-8");
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
        }

        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setWebChromeClient(new EditorChromeClient());
        webView.setWebViewClient(new EditorWebViewClient());
        setContentView(webView);

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void applyChromeColors(Window window) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.parseColor("#090a0f"));
            window.setNavigationBarColor(Color.parseColor("#0e1016"));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
            // stop any preview playback when the app goes to the background
            webView.evaluateJavascript(
                    "if (window.MS && document.getElementById('editor-screen') && " +
                    "!document.getElementById('editor-screen').classList.contains('hidden')) {" +
                    "try{MS.state.playing=false;}catch(e){} };", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        // Ask the web editor what back should do: close a sheet, leave the
        // editor, or exit the app.
        webView.evaluateJavascript(
                "(function(){try{ return window.MS && MS.handleBack ? MS.handleBack() : 'exit'; }" +
                "catch(e){ return 'exit'; }})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (value == null || value.contains("exit")) {
                            MainActivity.super.onBackPressed();
                        }
                    }
                });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[] { data.getData() };
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** Keeps file:// navigation inside the app, sends everything else to the system. */
    private class EditorWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url == null || url.startsWith("file://") || url.startsWith("about:")) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
                // no app can handle the link — stay put
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            view.setBackgroundColor(Color.parseColor("#090a0f"));
        }
    }

    /** Wires the web page's <input type="file"> up to the system picker. */
    private class EditorChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;
            try {
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(intent, REQUEST_FILE_CHOOSER);
                return true;
            } catch (Exception first) {
                try {
                    Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
                    fallback.addCategory(Intent.CATEGORY_OPENABLE);
                    fallback.setType("*/*");
                    fallback.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(fallback, REQUEST_FILE_CHOOSER);
                    return true;
                } catch (Exception second) {
                    filePathCallback = null;
                    return false;
                }
            }
        }
    }
}
