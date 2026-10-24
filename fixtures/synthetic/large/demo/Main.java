package demo;
import java.util.Scanner;
import demo.stages.Stage0;
import demo.stages.Stage1;
import demo.stages.Stage2;
import demo.stages.Stage3;
import demo.stages.Stage4;
import demo.stages.Stage5;
import demo.stages.Stage6;
import demo.stages.Stage7;
import demo.stages.Stage8;
public class Main {
  public static void main(String[] args) {
    Scanner input = new Scanner(System.in);
    int[] values = readValues(input);
    long total = evaluate(values);
    String result = format(total);
    write(result);
  }
  private static int[] readValues(Scanner input) {
    int count = input.nextInt();
    int[] values = new int[count];
    for (int index = 0; index < count; index++) {
      values[index] = input.nextInt();
    }
    return values;
  }
  private static long evaluate(int[] values) {
    long total = 0;
    total += Stage0.step0(values);
    total += Stage0.step1(values);
    total += Stage0.step2(values);
    total += Stage0.step3(values);
    total += Stage0.step4(values);
    total += Stage1.step0(values);
    total += Stage1.step1(values);
    total += Stage1.step2(values);
    total += Stage1.step3(values);
    total += Stage1.step4(values);
    total += Stage2.step0(values);
    total += Stage2.step1(values);
    total += Stage2.step2(values);
    total += Stage2.step3(values);
    total += Stage2.step4(values);
    total += Stage3.step0(values);
    total += Stage3.step1(values);
    total += Stage3.step2(values);
    total += Stage3.step3(values);
    total += Stage3.step4(values);
    total += Stage4.step0(values);
    total += Stage4.step1(values);
    total += Stage4.step2(values);
    total += Stage4.step3(values);
    total += Stage4.step4(values);
    total += Stage5.step0(values);
    total += Stage5.step1(values);
    total += Stage5.step2(values);
    total += Stage5.step3(values);
    total += Stage5.step4(values);
    total += Stage6.step0(values);
    total += Stage6.step1(values);
    total += Stage6.step2(values);
    total += Stage6.step3(values);
    total += Stage6.step4(values);
    total += Stage7.step0(values);
    total += Stage7.step1(values);
    total += Stage7.step2(values);
    total += Stage7.step3(values);
    total += Stage7.step4(values);
    total += Stage8.step0(values);
    total += Stage8.step1(values);
    total += Stage8.step2(values);
    total += Stage8.step3(values);
    total += Stage8.step4(values);
    return total;
  }
  private static String format(long total) {
    return "результат=" + total;
  }
  private static void write(String result) {
    System.out.println(result);
  }
}
