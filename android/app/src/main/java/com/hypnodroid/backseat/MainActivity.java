package com.hypnodroid.backseat;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Keep the screen on for as long as the game is in front.
     *
     * The whole simulation lives inside requestAnimationFrame (src/main.ts). When
     * the display sleeps, the WebView stops being drawn, rAF stops being called,
     * and the sim simply stops advancing. On the HOST that is not one player
     * pausing: it is the authoritative world freezing for everybody, with the BLE
     * link still up, so the joiners sit in a live game that has quietly stopped
     * ticking. Android's default display timeout is 30 seconds, and a phone put
     * down on a table between rounds hits it easily.
     *
     * FLAG_KEEP_SCREEN_ON is the right tool rather than a PowerManager WakeLock:
     * it is scoped to this window, so it needs no permission, it cannot leak (the
     * OS clears it when the activity stops being visible), and there is nothing to
     * remember to release. It does exactly what the game needs, which is to stay
     * awake while you are looking at it and not while you are not.
     *
     * What this deliberately does NOT do is keep the sim running while the app is
     * BACKGROUNDED. That would need a real foreground service; see the note in
     * docs/offline-coop.md. The plugin's startForegroundService() is not a
     * shortcut to one: its Android implementation is an empty method that calls
     * call.resolve() without starting anything, so it succeeds while doing nothing.
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
