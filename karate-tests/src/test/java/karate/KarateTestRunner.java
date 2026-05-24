package karate;

import com.intuit.karate.junit5.Karate;
import org.junit.jupiter.api.Test;
// Note: com.intuit.karate groupId confirmed for 1.4.1

class KarateTestRunner {

    @Test
    void runAllTests() {
        Karate.run("classpath:karate")
            .relativeTo(getClass())
            .outputCucumberJson(true)
            .outputJunitXml(true);
    }

    @Test
    void runInventoryTests() {
        Karate.run("classpath:karate/inventory")
            .relativeTo(getClass());
    }

    @Test
    void runOrderTests() {
        Karate.run("classpath:karate/orders")
            .relativeTo(getClass());
    }

    @Test
    void runSmokeTests() {
        Karate.run("classpath:karate")
            .tags("@smoke")
            .relativeTo(getClass());
    }
}
