# Cordn release ProGuard/R8 rules.
# R8 (release minify) only processes the native Kotlin/Java layer — the web bundle is minified
# separately by Vite, so the JS libs (ts-mls, @noble, applesauce, Svelte) are unaffected. These
# keeps cover the reflection/JNI surfaces R8 must not rename.

# Keep stack traces readable while dogfooding.
-keepattributes SourceFile,LineNumberTable,Signature,InnerClasses,EnclosingMethod,Exceptions
-renamesourcefileattribute SourceFile

# UniFFI-generated JNI bindings: Rust looks up Kotlin classes/methods by name. Keep the whole
# generated package verbatim so the FFI object/converter registry resolves at runtime.
-keep class uniffi.contextvm_ffi.** { *; }

# JNI native method symbols (defensive — proguard-android-optimize.txt also covers this).
-keepclasseswithmembernames class * {
    native <methods>;
}

# Capacitor resolves plugin classes by reflection (registerPlugin on the TS side). Keep the
# framework surface and our CordnBackground plugin package.
-keep class com.getcapacitor.** { *; }
-keep class org.cordn.background.** { *; }
