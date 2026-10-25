import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// CI passes the release tag and run number so each build upgrades the last one
// (Android only installs over an app whose versionCode is not lower).
val appVersionName = providers.gradleProperty("versionName").getOrElse("0.2.0")
val appVersionCode = providers.gradleProperty("versionCode").map { it.toInt() }.getOrElse(1)

// Release signing comes from keystore.properties or CADENCE_KEYSTORE_* env vars;
// with neither, the release build is signed with the Android debug key so it
// still installs. See docs/ANDROID.md.
val signing = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? =
    signing.getProperty(key) ?: System.getenv(env)?.takeIf { it.isNotBlank() }

val keystorePath = signingValue("storeFile", "CADENCE_KEYSTORE_FILE")
val hasReleaseKey = keystorePath != null && file(keystorePath).exists()

android {
    namespace = "net.hornetlinux.cadencemusic"
    compileSdk = 37

    defaultConfig {
        applicationId = "net.hornetlinux.cadencemusic"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        // DEBUG ONLY: a fixed, committed debug key so debug APKs built anywhere (Docker, CI,
        // another PC) update in place instead of needing an uninstall. Its password is the
        // well-known "android". Never use it for anything you publish; release signing below
        // is unchanged.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = signingValue("storePassword", "CADENCE_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "CADENCE_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "CADENCE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (hasReleaseKey) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        // Lint still runs and reports; a warning-level finding shouldn't block a release build.
        abortOnError = false
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.webkit)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.mlkit.genai.prompt)

    testImplementation(libs.junit)
    // The Android SDK's org.json is a stub in JVM unit tests.
    testImplementation(libs.org.json)
}
