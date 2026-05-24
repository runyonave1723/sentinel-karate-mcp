package karate;

import com.intuit.karate.Results;
import com.intuit.karate.Runner;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class KarateTestRunner {

    @Test
    void runAllTests() {
        Results results = Runner.path("classpath:karate")
            .outputCucumberJson(true)
            .outputJunitXml(true)
            .parallel(1);
        assertEquals(0, results.getFailCount(), results.getErrorMessages());
    }

    @Test
    void runInventoryTests() {
        Results results = Runner.path("classpath:karate/inventory")
            .outputCucumberJson(true)
            .outputJunitXml(true)
            .parallel(1);
        assertEquals(0, results.getFailCount(), results.getErrorMessages());
    }

    @Test
    void runOrderTests() {
        Results results = Runner.path("classpath:karate/orders")
            .outputCucumberJson(true)
            .outputJunitXml(true)
            .parallel(1);
        assertEquals(0, results.getFailCount(), results.getErrorMessages());
    }

    @Test
    void runSmokeTests() {
        Results results = Runner.path("classpath:karate")
            .tags("@smoke")
            .outputCucumberJson(true)
            .outputJunitXml(true)
            .parallel(1);
        assertEquals(0, results.getFailCount(), results.getErrorMessages());
    }
}
