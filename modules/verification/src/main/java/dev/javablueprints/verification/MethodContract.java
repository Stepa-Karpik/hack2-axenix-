package dev.javablueprints.verification;

import com.fasterxml.jackson.databind.JsonNode;
import static dev.javablueprints.verification.RunnerProtocol.*;
import java.nio.charset.StandardCharsets;

/** Native method channel, deliberately separate from stdout/stderr and console exact-v1. */
public final class MethodContract {
    private MethodContract() {}
    public static final String VERSION="method-v1";
    public static final String RESULT_PATH="/tmp/jb-method-result.json";
    public static final int MAX_RESULT=65536;
    public static final String PROFILE_HASH=hash((RunnerProtocol.PROFILE_HASH+"|method-v1-direct-static-typed-return-args-exception-depth8-nodes64").getBytes(StandardCharsets.UTF_8));
    public static JsonNode result(Bytes bytes) {
        try {
            if(bytes==null) return null;
            JsonNode value=JSON.readTree(bytes.decode(MAX_RESULT));
            if(value==null || !value.isObject() || !value.path("complete").asBoolean(false)
                || !(value.path("completion").asText().equals("return") || value.path("completion").asText().equals("throw"))
                || !value.path("argumentsAfter").isArray() || !value.has("returnValue") || !value.has("exception"))return null;
            if(value.path("completion").asText().equals("return")&&!value.get("exception").isNull())return null;
            if(value.path("completion").asText().equals("throw")&&(!value.get("returnValue").isNull()||!value.get("exception").isObject()||!exception(value.get("exception"),0,new int[]{0})))return null;
            return value;
        } catch(Exception invalid) {return null;}
    }
    private static boolean exception(JsonNode value,int depth,int[] count) {
        if(value.isNull())return true;
        if(depth>8||++count[0]>64||!value.isObject()||!value.path("type").isTextual()||!value.has("message")||!(value.get("message").isNull()||value.get("message").isTextual())||!value.has("cause")||!value.path("suppressed").isArray()||value.get("suppressed").size()>16)return false;
        if(!exception(value.get("cause"),depth+1,count))return false;
        for(var suppressed:value.get("suppressed"))if(suppressed.isNull()||!exception(suppressed,depth+1,count))return false;
        return true;
    }
    public static boolean equal(Observation left,Observation right) {
        var a=result(left.methodResult());var b=result(right.methodResult());
        return a!=null && a.equals(b) && Comparator.equal(left,right);
    }
    public static Object view(Bytes bytes) {
        var value=result(bytes);
        return value==null?null:JSON.convertValue(value,Object.class);
    }
    public static boolean oracle(TestCase input,Observation value) {
        try {return input.expectedMethodResult()==null || JSON.readTree(input.expectedMethodResult()).equals(result(value.methodResult()));}
        catch(Exception invalid){return false;}
    }
}
