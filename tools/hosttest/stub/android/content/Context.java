package android.content;
/** 宿主 JVM 单测用的最小桩：只为让 javac 过一遍，方法体一律抛「不该被调到」。 */
public class Context {
    public static final int MODE_PRIVATE = 0;
    public Context getApplicationContext() { throw new RuntimeException("桩：不该被调用"); }
    public SharedPreferences getSharedPreferences(String name, int mode) { throw new RuntimeException("桩：不该被调用"); }
}
