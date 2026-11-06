package com.niyutkumar.zerodoori;

import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * ZeroDoori's Android app is a thin shell around the ZeroDoori website.
 * On top of what Capacitor gives us, this adds:
 *  - real full-screen video when you tap YouTube's full-screen button (rotates to landscape),
 *  - the Back button leaves full screen instead of closing the app,
 *  - the screen stays on while the app is open, so it doesn't dim during a video.
 */
public class MainActivity extends BridgeActivity {

    private View fullscreenView;
    private android.webkit.WebChromeClient.CustomViewCallback fullscreenCallback;
    private OnBackPressedCallback exitFullscreenOnBack;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        Bridge bridge = getBridge();
        if (bridge != null) {
            WebView webView = bridge.getWebView();
            webView.setWebChromeClient(new FullscreenChromeClient(bridge));
        }

        exitFullscreenOnBack = new OnBackPressedCallback(false) {
            @Override
            public void handleOnBackPressed() {
                exitFullscreen();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, exitFullscreenOnBack);
    }

    private void enterFullscreen(View view, android.webkit.WebChromeClient.CustomViewCallback callback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden();
            return;
        }
        fullscreenView = view;
        fullscreenCallback = callback;

        FrameLayout decor = (FrameLayout) getWindow().getDecorView();
        decor.addView(view, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), decor);
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);

        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        exitFullscreenOnBack.setEnabled(true);
    }

    private void exitFullscreen() {
        if (fullscreenView == null) {
            return;
        }
        FrameLayout decor = (FrameLayout) getWindow().getDecorView();
        decor.removeView(fullscreenView);
        fullscreenView = null;

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), decor);
        controller.show(WindowInsetsCompat.Type.systemBars());

        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        exitFullscreenOnBack.setEnabled(false);

        if (fullscreenCallback != null) {
            fullscreenCallback.onCustomViewHidden();
            fullscreenCallback = null;
        }
    }

    /** Capacitor's default client turns full screen off; this one shows it properly. */
    private class FullscreenChromeClient extends BridgeWebChromeClient {
        FullscreenChromeClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            enterFullscreen(view, callback);
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }
    }
}
