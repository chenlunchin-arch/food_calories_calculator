package com.platemeter.app

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.File
import java.nio.FloatBuffer
import java.util.concurrent.Executors

/**
 * Runs the on-device food model (assets/model/image_encoder.onnx).
 *
 * The page sends square 256x256 RGB crops (3 bytes per pixel, several crops
 * back to back) as base64. We return one 512-number embedding per crop.
 * All matching against dish names happens in the page's JavaScript.
 */
class FoodEmbedder(private val context: Context, private val webView: WebView) {

    private val worker = Executors.newSingleThreadExecutor()
    private var session: OrtSession? = null

    companion object {
        const val SIZE = 256
        private const val ASSET = "model/image_encoder.onnx"
    }

    private fun ensureSession(): OrtSession {
        session?.let { return it }
        // Copy the model out of the APK once, so ONNX Runtime can read it from a file
        // instead of holding a second copy in Java memory.
        val file = File(context.filesDir, "image_encoder.onnx")
        val stamp = File(context.filesDir, "image_encoder.version")
        val version = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        if (!file.exists() || !stamp.exists() || stamp.readText() != version) {
            context.assets.open(ASSET).use { input -> file.outputStream().use { input.copyTo(it) } }
            stamp.writeText(version)
        }
        val e = OrtEnvironment.getEnvironment()
        val opts = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(1, 4))
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        }
        val s = e.createSession(file.absolutePath, opts)
        session = s
        return s
    }

    /** True when the model file is packaged in this build. */
    @JavascriptInterface
    fun available(): Boolean = try {
        context.assets.open(ASSET).close(); true
    } catch (e: Exception) {
        false
    }

    /**
     * Starts embedding in the background. Answers by calling
     * window.__plateEmbed(id, {"ok":true,"emb":[[...],[...]]}) or {"ok":false,"error":"..."}.
     */
    @JavascriptInterface
    fun embed(id: String, rgbBase64: String) {
        worker.execute {
            val reply = try {
                val bytes = Base64.decode(rgbBase64, Base64.DEFAULT)
                val per = SIZE * SIZE * 3
                require(bytes.isNotEmpty() && bytes.size % per == 0) { "bad image size ${bytes.size}" }
                val n = bytes.size / per
                val floats = FloatArray(bytes.size)
                for (i in bytes.indices) floats[i] = (bytes[i].toInt() and 0xFF).toFloat()

                val s = ensureSession()
                val inputName = s.inputNames.first()
                OnnxTensor.createTensor(OrtEnvironment.getEnvironment(), FloatBuffer.wrap(floats), longArrayOf(n.toLong(), SIZE.toLong(), SIZE.toLong(), 3L)).use { tensor ->
                    s.run(mapOf(inputName to tensor)).use { result ->
                        @Suppress("UNCHECKED_CAST")
                        val out = result[0].value as Array<FloatArray>
                        val sb = StringBuilder(n * 512 * 9)
                        sb.append("{\"ok\":true,\"emb\":[")
                        out.forEachIndexed { r, row ->
                            if (r > 0) sb.append(',')
                            sb.append('[')
                            row.forEachIndexed { c, v ->
                                if (c > 0) sb.append(',')
                                sb.append(String.format(java.util.Locale.US, "%.5f", v))
                            }
                            sb.append(']')
                        }
                        sb.append("]}")
                        sb.toString()
                    }
                }
            } catch (t: Throwable) {
                JSONObject().put("ok", false).put("error", t.toString()).toString()
            }
            val safeId = JSONObject.quote(id)
            webView.post { webView.evaluateJavascript("window.__plateEmbed && window.__plateEmbed($safeId, $reply)", null) }
        }
    }
}
