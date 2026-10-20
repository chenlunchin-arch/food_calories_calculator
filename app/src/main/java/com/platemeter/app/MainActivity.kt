package com.platemeter.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import java.io.File

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraFile: File? = null
    private var cameraUri: Uri? = null

    companion object {
        private const val REQ_PHOTO = 1001
        // Assets are served from a real https origin so localStorage and fetch behave normally.
        private const val START_URL = "https://appassets.androidplatform.net/assets/index.html"
    }

    private lateinit var embedder: FoodEmbedder

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cleanOldCaptures()

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#F3F6FA"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
        }
        setContentView(webView)
        embedder = FoodEmbedder(this, webView)
        webView.addJavascriptInterface(embedder, "PlateNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return openPhotoChooser()
            }
        }

        if (savedInstanceState != null) webView.restoreState(savedInstanceState)
        else webView.loadUrl(START_URL)
    }

    /**
     * Removes camera captures older than a day. Never deletes on each chooser open:
     * the "before" photo must still be readable when the "after" photo is taken.
     */
    private fun cleanOldCaptures() {
        val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000
        File(cacheDir, "camera").listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    }

    /** Offers "take a photo" plus the gallery / file pickers in one chooser. */
    private fun openPhotoChooser(): Boolean {
        // If the camera file can't be prepared, still offer the gallery.
        val camera: Intent? = try {
            val dir = File(cacheDir, "camera").apply { mkdirs() }
            val file = File.createTempFile("meal_", ".jpg", dir)
            cameraFile = file
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            cameraUri = uri
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        } catch (e: Exception) {
            cameraFile = null
            cameraUri = null
            null
        }
        val gallery = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/*"
        }
        val chooser = Intent.createChooser(gallery, "拍照或選擇照片").apply {
            if (camera != null) putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
        }
        return try {
            startActivityForResult(chooser, REQ_PHOTO)
            true
        } catch (e: ActivityNotFoundException) {
            fileCallback = null
            false
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PHOTO) return
        val callback = fileCallback ?: return
        fileCallback = null

        if (resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return
        }
        val picked = data?.data
        val shot = cameraFile?.takeIf { it.exists() && it.length() > 0 }?.let { cameraUri }
        val result = when {
            picked != null -> arrayOf(picked)
            shot != null -> arrayOf(shot)
            else -> null
        }
        callback.onReceiveValue(result)
    }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        embedder.close()
        webView.removeJavascriptInterface("PlateNative")
        webView.destroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
