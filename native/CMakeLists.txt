cmake_minimum_required(VERSION 3.24)
project(face_probe LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(FACE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(SDK_ROOT "${FACE_ROOT}/vendor/Audio2Face-3D-SDK")
find_package(CUDAToolkit 12.8 REQUIRED)
add_executable(face_probe face_probe.cpp)
target_include_directories(face_probe PRIVATE
  "${SDK_ROOT}/audio2face-sdk/include"
  "${SDK_ROOT}/audio2x-common/include"
  "${SDK_ROOT}/_deps/target-deps/audiofile/include"
  "${SDK_ROOT}/_deps/target-deps/nlohmann_json/include")
target_link_libraries(face_probe PRIVATE
  "${FACE_ROOT}/build/sdk/audio2x-sdk/lib/audio2x.lib" CUDA::cudart)
if(MSVC)
  target_compile_options(face_probe PRIVATE /utf-8 /EHsc)
endif()
