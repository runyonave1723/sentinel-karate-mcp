package karate;

import com.intuit.karate.junit5.Karate;
import org.junit.jupiter.api.Test;

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
