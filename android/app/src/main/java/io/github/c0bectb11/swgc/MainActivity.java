package io.github.c0bectb11.swgc;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Star Wars: Global Conflict — окно с игрой.
 *
 * Внутри открывается сайт игры, поэтому обновления игры приходят сами, без новой версии
 * приложения. Здесь только то, чего нет у вкладки браузера: весь экран без адресной строки,
 * экран не гаснет в бою, поворот без перезагрузки, восстановление после того, как слабый
 * телефон выгрузил движок страницы, и страница «нет связи» вместо пустоты.
 */
public class MainActivity extends Activity {
    static final String HOME = "https://c0bectb11.github.io/SW-RPG2.0/";
    static final String HOST = "c0bectb11.github.io";
    static final String PATH = "/SW-RPG2.0";

    private FrameLayout root;
    private WebView web;
    private String lastUrl = HOME;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setBackgroundColor(Color.rgb(5, 6, 10));
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(5, 6, 10));
        setContentView(root);
        makeWeb();
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(HOME);
        immersive();
    }

    private void makeWeb() {
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(5, 6, 10));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);                       // крупный системный шрифт не ломает вёрстку игры
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " SWGC-App/" + version());   // сайт узнаёт, что он в приложении
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (isGame(u)) return false;
                // чужие ссылки — в браузер телефона, игра остаётся на месте
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.startsWith("https://")) lastUrl = url;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) offline();
            }

            // Слабый телефон выгрузил движок страницы ради памяти — не падать, а открыть игру заново
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                root.removeView(web);
                web.destroy();
                makeWeb();
                web.loadUrl(lastUrl);
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "1"; }
    }

    private static boolean isGame(Uri u) {
        if (u == null) return false;
        String path = u.getPath() == null ? "" : u.getPath();
        return "https".equals(u.getScheme()) && HOST.equals(u.getHost()) && path.startsWith(PATH);
    }

    private void offline() {
        String html = "<!doctype html><html lang=ru><head><meta charset=utf-8>"
            + "<meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;"
            + "background:#05060a;color:#cfd8dc;font:14px 'Courier New',monospace;text-align:center}"
            + "h1{color:#d9a940;font-size:13px;letter-spacing:3px;font-weight:normal;margin:0 0 12px}"
            + "p{color:#8fa8c4;margin:0 24px 22px;line-height:1.5}"
            + "a{display:inline-block;padding:12px 22px;border:1px solid #d9a940;border-radius:8px;"
            + "color:#e8d9a8;text-decoration:none;letter-spacing:1px}</style></head><body><div>"
            + "<h1>НЕТ СВЯЗИ</h1><p>Сервер игры не отвечает. Проверь интернет и попробуй снова.</p>"
            + "<a href='" + lastUrl + "'>ПОВТОРИТЬ</a></div></body></html>";
        web.loadDataWithBaseURL(HOME, html, "text/html", "utf-8", lastUrl);
    }

    // Весь экран: системные панели прячутся, свайп от края показывает их на время
    @SuppressWarnings("deprecation")
    private void immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);            // не закрывать игру по «назад» — просто свернуть
    }

    @Override
    protected void onPause() { super.onPause(); if (web != null) { web.onPause(); CookieManager.getInstance().flush(); } }

    @Override
    protected void onResume() { super.onResume(); if (web != null) web.onResume(); immersive(); }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); if (web != null) web.saveState(out); }

    @Override
    protected void onDestroy() { if (web != null) { root.removeView(web); web.destroy(); web = null; } super.onDestroy(); }
}
