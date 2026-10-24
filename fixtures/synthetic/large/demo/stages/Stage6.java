package demo.stages;
public final class Stage6 {
  public static int step0(int[] values) {
    int sum = 0;
    int count = 0;
    int maximum = 0;
    int minimum = Integer.MAX_VALUE;
    for (int index = 0; index < values.length; index++) {
      int value = values[index] + 31;
      if (value < 0) {
        value = -value;
      }
      if ((value & 1) == 0) {
        sum += value / 2;
      } else {
        sum += value * 2;
      }
      if (value > maximum) maximum = value;
      if (value < minimum) minimum = value;
      count++;
    }
    if (count == 0) return 0;
    return sum + maximum - minimum + count;
  }
  public static int step1(int[] values) {
    int sum = 0;
    int count = 0;
    int maximum = 0;
    int minimum = Integer.MAX_VALUE;
    for (int index = 0; index < values.length; index++) {
      int value = values[index] + 32;
      if (value < 0) {
        value = -value;
      }
      if ((value & 1) == 0) {
        sum += value / 2;
      } else {
        sum += value * 2;
      }
      if (value > maximum) maximum = value;
      if (value < minimum) minimum = value;
      count++;
    }
    if (count == 0) return 0;
    return sum + maximum - minimum + count;
  }
  public static int step2(int[] values) {
    int sum = 0;
    int count = 0;
    int maximum = 0;
    int minimum = Integer.MAX_VALUE;
    for (int index = 0; index < values.length; index++) {
      int value = values[index] + 33;
      if (value < 0) {
        value = -value;
      }
      if ((value & 1) == 0) {
        sum += value / 2;
      } else {
        sum += value * 2;
      }
      if (value > maximum) maximum = value;
      if (value < minimum) minimum = value;
      count++;
    }
    if (count == 0) return 0;
    return sum + maximum - minimum + count;
  }
  public static int step3(int[] values) {
    int sum = 0;
    int count = 0;
    int maximum = 0;
    int minimum = Integer.MAX_VALUE;
    for (int index = 0; index < values.length; index++) {
      int value = values[index] + 34;
      if (value < 0) {
        value = -value;
      }
      if ((value & 1) == 0) {
        sum += value / 2;
      } else {
        sum += value * 2;
      }
      if (value > maximum) maximum = value;
      if (value < minimum) minimum = value;
      count++;
    }
    if (count == 0) return 0;
    return sum + maximum - minimum + count;
  }
  public static int step4(int[] values) {
    int sum = 0;
    int count = 0;
    int maximum = 0;
    int minimum = Integer.MAX_VALUE;
    for (int index = 0; index < values.length; index++) {
      int value = values[index] + 35;
      if (value < 0) {
        value = -value;
      }
      if ((value & 1) == 0) {
        sum += value / 2;
      } else {
        sum += value * 2;
      }
      if (value > maximum) maximum = value;
      if (value < minimum) minimum = value;
      count++;
    }
    if (count == 0) return 0;
    return sum + maximum - minimum + count;
  }
}
