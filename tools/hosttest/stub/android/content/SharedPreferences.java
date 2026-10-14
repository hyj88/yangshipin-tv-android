package android.content;
import java.util.Map;
public interface SharedPreferences {
    String getString(String k, String def);
    Editor edit();
    interface Editor {
        Editor putString(String k, String v);
        Editor remove(String k);
        void apply();
    }
}
