#include "audio2face/audio2face.h"
#include "audio2x/cuda_utils.h"
#include "AudioFile.h"
#include <cuda_runtime.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using Clock = std::chrono::steady_clock;
using Json = nlohmann::json;
struct Destroyer {
    template<class T> void operator()(T* value) const { if (value) value->Destroy(); }
};
template<class T> using Owner = std::unique_ptr<T, Destroyer>;
void check(std::error_code value) {
    if (value) throw std::runtime_error(value.message());
}
void checkCuda(cudaError_t value) {
    if (value != cudaSuccess) throw std::runtime_error(cudaGetErrorString(value));
}
double seconds(Clock::time_point start) {
    return std::chrono::duration<double>(Clock::now() - start).count();
}
struct Frame {
    long long timestamp;
    std::size_t received;
    std::vector<float> weights;
};
struct Collector {
    std::vector<Frame> frames;
    std::size_t received = 0;
    std::string error;
};

int main(int argc, char** argv) {
    try {
        if (argc < 4 || argc > 6) {
            std::cerr << "Usage: face_probe MODEL_JSON MONO_16K_WAV OUTPUT_JSON [CHUNK_SAMPLES] [FPS]\n";
            return 2;
        }
        const std::size_t chunkSamples = argc >= 5 ? std::stoull(argv[4]) : 0;
        const std::size_t fps = argc >= 6 ? std::stoull(argv[5]) : 30;
        if (fps < 1 || fps > 120) throw std::runtime_error("FPS must be between 1 and 120");
        AudioFile<float> wav;
        if (!wav.load(argv[2]) || wav.getSampleRate() != 16000 || wav.getNumChannels() != 1 || wav.samples[0].empty()) {
            throw std::runtime_error("Expected a nonempty mono 16000 Hz WAV");
        }
        const auto& samples = wav.samples[0];
        check(nva2x::SetCudaDeviceIfNeeded(0));
        std::size_t freeBefore = 0, totalVram = 0;
        checkCuda(cudaMemGetInfo(&freeBefore, &totalVram));
        cudaDeviceProp gpu{};
        checkCuda(cudaGetDeviceProperties(&gpu, 0));
        const auto loadStart = Clock::now();
        nva2f::IRegressionModel::IGeometryModelInfo* rawGeometry = nullptr;
        nva2f::IRegressionModel::IBlendshapeSolveModelInfo* rawBlendshape = nullptr;
        const auto option = nva2f::IGeometryExecutor::ExecutionOption::SkinTongue;
        auto* rawBundle = nva2f::ReadRegressionBlendshapeSolveExecutorBundle(
            1, argv[1], option, true, fps, 1, &rawGeometry, &rawBlendshape);
        Owner<nva2f::IRegressionModel::IGeometryModelInfo> geometry(rawGeometry);
        Owner<nva2f::IRegressionModel::IBlendshapeSolveModelInfo> blendshape(rawBlendshape);
        Owner<nva2f::IBlendshapeExecutorBundle> bundle(rawBundle);
        if (!bundle || !geometry || !blendshape) throw std::runtime_error("SDK model bundle failed to load");
        const double loadSeconds = seconds(loadStart);
        auto& executor = bundle->GetExecutor();
        if (executor.GetResultType() != nva2f::IBlendshapeExecutor::ResultsType::DEVICE) {
            throw std::runtime_error("Expected GPU blendshape solver output");
        }
        std::vector<std::string> names;
        auto config = blendshape->GetExecutorCreationParameters(option);
        for (auto* part : {config.initializationSkinParams, config.initializationTongueParams}) {
            if (part) for (std::size_t i = 0; i < part->data.poseNamesSize; ++i) names.emplace_back(part->data.poseNames[i]);
        }
        if (names.size() != executor.GetWeightCount()) throw std::runtime_error("Blendshape name/count mismatch");
        Collector collected;
        collected.frames.reserve(samples.size() * fps / 16000 + 8);
        check(executor.SetResultsCallback(+[](void* userdata, const nva2f::IBlendshapeExecutor::DeviceResults& result) {
            auto& data = *static_cast<Collector*>(userdata);
            try {
                Frame frame{result.timeStampCurrentFrame, data.received, std::vector<float>(result.weights.Size())};
                checkCuda(cudaMemcpyAsync(frame.weights.data(), result.weights.Data(), frame.weights.size() * sizeof(float),
                                          cudaMemcpyDeviceToHost, result.cudaStream));
                checkCuda(cudaStreamSynchronize(result.cudaStream));
                for (float weight : frame.weights) if (!std::isfinite(weight)) throw std::runtime_error("Nonfinite blendshape weight");
                data.frames.push_back(std::move(frame));
                return true;
            } catch (const std::exception& error) {
                data.error = error.what();
                return false;
            }
        }, &collected));
        auto stream = bundle->GetCudaStream().Data();
        auto& emotions = bundle->GetEmotionAccumulator(0);
        std::vector<float> neutral(emotions.GetEmotionSize(), 0.0f);
        check(emotions.Accumulate(0, nva2x::HostTensorFloatConstView{neutral.data(), neutral.size()}, stream));
        check(emotions.Close());
        auto& audio = bundle->GetAudioAccumulator(0);
        const auto inferenceStart = Clock::now();
        const auto runAvailable = [&]() {
            while (nva2x::GetNbReadyTracks(executor) > 0) {
                check(executor.Execute(nullptr));
                if (!collected.error.empty()) throw std::runtime_error(collected.error);
            }
        };
        if (chunkSamples) {
            for (std::size_t offset = 0; offset < samples.size(); offset += chunkSamples) {
                auto count = std::min(chunkSamples, samples.size() - offset);
                check(audio.Accumulate(nva2x::HostTensorFloatConstView{samples.data() + offset, count}, stream));
                collected.received = offset + count;
                runAvailable();
            }
            check(audio.Close());
            runAvailable();
        } else {
            check(audio.Accumulate(nva2x::HostTensorFloatConstView{samples.data(), samples.size()}, stream));
            collected.received = samples.size();
            check(audio.Close());
            runAvailable();
        }
        check(executor.Wait(0));
        checkCuda(cudaStreamSynchronize(stream));
        const double inferenceSeconds = seconds(inferenceStart);
        if (collected.frames.empty() || collected.frames.size() != executor.GetTotalNbFrames(0)) {
            throw std::runtime_error("Incomplete animation frame output");
        }
        std::size_t freeAfter = 0;
        checkCuda(cudaMemGetInfo(&freeAfter, &totalVram));
        Json output = {
            {"format", "audio2face-blendshapes-v1"}, {"model", "Claire 2.3.1"},
            {"audio_path", argv[2]}, {"model_config", argv[1]}, {"gpu", gpu.name},
            {"sample_rate", 16000}, {"fps", fps}, {"audio_seconds", samples.size() / 16000.0},
            {"load_seconds", loadSeconds}, {"inference_seconds", inferenceSeconds},
            {"realtime_factor", inferenceSeconds / (samples.size() / 16000.0)},
            {"chunk_samples", chunkSamples}, {"streaming_test_paced_in_wall_time", false},
            {"first_output_after_audio_seconds", collected.frames.front().received / 16000.0},
            {"vram_free_difference_bytes", static_cast<long long>(freeBefore) - static_cast<long long>(freeAfter)},
            {"frame_count", collected.frames.size()}, {"weight_count", names.size()}, {"blendshape_names", names},
            {"explicit_emotions", neutral}, {"frames", Json::array()}
        };
        for (const auto& frame : collected.frames) {
            output["frames"].push_back({{"time", frame.timestamp / 16000.0},
                {"audio_received_seconds", frame.received / 16000.0}, {"weights", frame.weights}});
        }
        std::ofstream file(argv[3]);
        file << output.dump();
        if (!file) throw std::runtime_error("Could not write result JSON");
        output.erase("frames");
        std::cout << output.dump(2) << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "ERROR: " << error.what() << '\n';
        return 1;
    }
}
